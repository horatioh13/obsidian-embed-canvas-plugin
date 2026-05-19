import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath
} from "obsidian";

type PreviewFormat = "png" | "jpg" | "webp";
type RenderContext = "note" | "canvas";

interface CanvasPreviewSettings {
	previewFolder: string;
	hidePreviewFolderInFileExplorer: boolean;
	autoExcludePreviewFolder: boolean;
	maxCanvasEmbedDepth: number;
	format: PreviewFormat;
	quality: number;
	maxDimension: number;
	pixelRatio: number;
	debounceMs: number;
	renderInNotes: boolean;
	renderInCanvas: boolean;
	regenerateOnStartup: boolean;
}

const DEFAULT_SETTINGS: CanvasPreviewSettings = {
	previewFolder: "canvas-previews",
	hidePreviewFolderInFileExplorer: true,
	autoExcludePreviewFolder: true,
	maxCanvasEmbedDepth: 2,
	format: "png",
	quality: 0.9,
	maxDimension: 1800,
	pixelRatio: 1.4,
	debounceMs: 500,
	renderInNotes: true,
	renderInCanvas: true,
	regenerateOnStartup: true
};

const PREVIEW_MIME: Record<PreviewFormat, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp"
};

const PREVIEW_CLASS = "canvas-autoupdate-preview-image";
const PREVIEW_HOST_CLASS = "canvas-autoupdate-preview-host";
const PREVIEW_NODE_CLASS = "canvas-autoupdate-node-preview-image";
const PREVIEW_NODE_HOST_CLASS = "canvas-autoupdate-node-preview-host";

interface VaultConfigApi {
	getConfig(key: string): unknown;
	setConfig(key: string, value: unknown): Promise<void> | void;
}

interface CanvasRenderState {
	depth: number;
}

interface JsonCanvasData {
	nodes?: JsonCanvasNode[];
	edges?: JsonCanvasEdge[];
}

interface JsonCanvasNode {
	id: string;
	type: "text" | "file" | "link" | "group";
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	file?: string;
	url?: string;
	label?: string;
}

interface JsonCanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide?: "top" | "right" | "bottom" | "left";
	toSide?: "top" | "right" | "bottom" | "left";
	color?: string;
	label?: string;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

interface CanvasLeafView {
	file?: TFile;
	containerEl?: HTMLElement;
	canvas?: {
		wrapperEl?: HTMLElement;
		nodes?: Map<string, CanvasNodeView> | Record<string, CanvasNodeView> | CanvasNodeView[];
	};
}

interface MarkdownLeafView {
	file?: TFile;
	contentEl?: HTMLElement;
}

interface CanvasNodeDataView {
	type?: string;
	file?: string;
}

interface CanvasNodeView {
	contentEl?: HTMLElement;
	getData?: () => CanvasNodeDataView;
}

interface PreviewRenderOptions {
	targetEl: HTMLElement;
	previewUrl: string;
	imageClass: string;
	hostClass: string;
	alt: string;
	cacheKey: string;
	context?: RenderContext;
}

export default class CanvasAutoupdatePreviewsPlugin extends Plugin {
	settings: CanvasPreviewSettings = DEFAULT_SETTINGS;
	private generationTimers = new Map<string, number>();
	private embedRefreshTimer: number | null = null;
	private observer: MutationObserver | null = null;
	private previewFolderHideStyleEl: HTMLStyleElement | null = null;
	private createEventReady = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshPreviewFolderExplorerVisibility();
		await this.ensurePreviewFolderExcluded();

		this.addSettingTab(new CanvasAutoupdatePreviewSettingsTab(this.app, this));
		this.registerVaultEvents();

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.renderInNotes) {
				return;
			}

			void this.applyPreviewsInRoot(el, ctx.sourcePath, "note");
		});

		this.installEmbedObserver();

		this.app.workspace.onLayoutReady(() => {
			this.createEventReady = true;
			this.scheduleEmbedRefresh();
			if (this.settings.regenerateOnStartup) {
				void this.regenerateAllPreviews("startup");
			}
		});
	}

	onunload(): void {
		for (const timer of this.generationTimers.values()) {
			window.clearTimeout(timer);
		}
		this.generationTimers.clear();

		if (this.embedRefreshTimer !== null) {
			window.clearTimeout(this.embedRefreshTimer);
			this.embedRefreshTimer = null;
		}

		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}

		this.clearPreviewFolderExplorerVisibility();
	}

	async loadSettings(): Promise<void> {
		const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as CanvasPreviewSettings;
		const normalizedPreviewFolder = normalizePath(loaded.previewFolder || "").replace(/^\/+|\/+$/g, "");
		loaded.previewFolder = normalizedPreviewFolder || DEFAULT_SETTINGS.previewFolder;
		loaded.maxCanvasEmbedDepth = Math.max(0, Math.round(loaded.maxCanvasEmbedDepth ?? DEFAULT_SETTINGS.maxCanvasEmbedDepth));
		this.settings = loaded;
	}

	async saveSettings(): Promise<void> {
		const normalizedPreviewFolder = normalizePath(this.settings.previewFolder || "").replace(/^\/+|\/+$/g, "");
		this.settings.previewFolder = normalizedPreviewFolder || DEFAULT_SETTINGS.previewFolder;
		await this.saveData(this.settings);
		this.scheduleEmbedRefresh();
		this.refreshPreviewFolderExplorerVisibility();
		await this.ensurePreviewFolderExcluded();
	}

	private getPreviewFolderPath(): string {
		const normalizedPreviewFolder = normalizePath(this.settings.previewFolder || "").replace(/^\/+|\/+$/g, "");
		return normalizedPreviewFolder || DEFAULT_SETTINGS.previewFolder;
	}

	private getVaultConfigApi(): VaultConfigApi | null {
		const configApi = this.app.vault as unknown as Partial<VaultConfigApi>;
		if (typeof configApi.getConfig !== "function" || typeof configApi.setConfig !== "function") {
			return null;
		}

		return configApi as VaultConfigApi;
	}

	private async ensurePreviewFolderExcluded(): Promise<void> {
		if (!this.settings.autoExcludePreviewFolder) {
			return;
		}

		const configApi = this.getVaultConfigApi();
		if (!configApi) {
			return;
		}

		const previewFolder = this.getPreviewFolderPath();
		const excludePattern = `${previewFolder}/**`;
		const existingFilters = configApi.getConfig("userIgnoreFilters");
		const currentFilters = Array.isArray(existingFilters)
			? existingFilters.filter((value): value is string => typeof value === "string")
			: [];

		if (currentFilters.includes(excludePattern)) {
			return;
		}

		const nextFilters = [...currentFilters, excludePattern];
		await Promise.resolve(configApi.setConfig("userIgnoreFilters", nextFilters));
	}

	private escapeCssAttributeValue(value: string): string {
		if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
			return CSS.escape(value);
		}

		return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}

	private clearPreviewFolderExplorerVisibility(): void {
		if (this.previewFolderHideStyleEl) {
			this.previewFolderHideStyleEl.remove();
			this.previewFolderHideStyleEl = null;
		}
	}

	private refreshPreviewFolderExplorerVisibility(): void {
		this.clearPreviewFolderExplorerVisibility();

		if (!this.settings.hidePreviewFolderInFileExplorer) {
			return;
		}

		const previewFolder = this.getPreviewFolderPath();
		if (!previewFolder) {
			return;
		}

		const exactPath = this.escapeCssAttributeValue(previewFolder);
		const childPrefix = this.escapeCssAttributeValue(`${previewFolder}/`);
		const style = document.createElement("style");
		style.textContent = `
			.workspace-leaf-content[data-type="file-explorer"] [data-path="${exactPath}"],
			.workspace-leaf-content[data-type="file-explorer"] [data-path^="${childPrefix}"] {
				display: none !important;
			}
		`;
		document.head.appendChild(style);
		this.previewFolderHideStyleEl = style;
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (this.isCanvasFile(file)) {
					this.schedulePreviewGeneration(file.path);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.createEventReady) {
					return;
				}
				if (this.isCanvasFile(file)) {
					this.schedulePreviewGeneration(file.path);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.isCanvasFile(file)) {
					return;
				}

				void this.deletePreviewSetForCanvasPath(oldPath);
				this.schedulePreviewGeneration(file.path);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.isCanvasAbstractFile(file)) {
					return;
				}

				void this.deletePreviewSetForCanvasPath(file.path);
			})
		);
	}

	private installEmbedObserver(): void {
		this.observer = new MutationObserver((mutations) => {
			let shouldRefresh = false;
			for (const mutation of mutations) {
				if (mutation.type === "childList") {
					if (mutation.addedNodes.length > 0) {
						shouldRefresh = true;
						break;
					}
				} else if (mutation.type === "attributes") {
					shouldRefresh = true;
					break;
				}
			}

			if (shouldRefresh) {
				this.scheduleEmbedRefresh();
			}
		});

		this.observer.observe(this.app.workspace.containerEl, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["src", "data-href", "class"]
		});
	}

	private scheduleEmbedRefresh(): void {
		if (this.embedRefreshTimer !== null) {
			window.clearTimeout(this.embedRefreshTimer);
		}

		this.embedRefreshTimer = window.setTimeout(() => {
			this.embedRefreshTimer = null;
			void this.refreshVisibleEmbeds();
		}, 180);
	}

	private async refreshVisibleEmbeds(): Promise<void> {
		const embeds = Array.from(
			this.app.workspace.containerEl.querySelectorAll<HTMLElement>(".internal-embed[src], .internal-embed[data-href]")
		);

		const operations: Promise<void>[] = [];
		for (const embed of embeds) {
			const insideCanvasLeaf = Boolean(embed.closest('.workspace-leaf-content[data-type="canvas"]'));
			if (insideCanvasLeaf && !this.settings.renderInCanvas) {
				continue;
			}
			if (!insideCanvasLeaf && !this.settings.renderInNotes) {
				continue;
			}

			const sourcePath = this.resolveSourcePathForElement(embed, insideCanvasLeaf);
			if (!sourcePath) {
				continue;
			}

			const context: RenderContext = insideCanvasLeaf ? "canvas" : "note";
			operations.push(this.applyPreviewToEmbedElement(embed, sourcePath, context));
		}

		await Promise.all(operations);

		if (this.settings.renderInCanvas) {
			await this.refreshCanvasFileNodePreviews();
		}
	}

	private getCanvasNodeViews(view: CanvasLeafView): CanvasNodeView[] {
		const nodes = view.canvas?.nodes;
		if (!nodes) {
			return [];
		}
		if (nodes instanceof Map) {
			return Array.from(nodes.values());
		}
		if (Array.isArray(nodes)) {
			return nodes;
		}
		return Object.values(nodes);
	}

	private async refreshCanvasFileNodePreviews(): Promise<void> {
		const operations: Promise<void>[] = [];

		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view as unknown as CanvasLeafView;
			const sourcePath = view.file?.path;
			if (!sourcePath) {
				continue;
			}

			for (const node of this.getCanvasNodeViews(view)) {
				operations.push(this.applyPreviewToCanvasFileNode(node, sourcePath));
			}
		}

		await Promise.all(operations);
	}

	private async applyPreviewToCanvasFileNode(node: CanvasNodeView, sourcePath: string): Promise<void> {
		const nodeData = node.getData?.();
		if (!nodeData || nodeData.type !== "file" || !nodeData.file) {
			return;
		}

		const canvasFile = this.resolveCanvasFile(nodeData.file, sourcePath);
		if (!canvasFile) {
			return;
		}

		const contentEl = node.contentEl;
		if (!contentEl) {
			return;
		}

		const previewFile = await this.ensurePreviewFile(canvasFile);
		if (!previewFile) {
			return;
		}

		const previewUrl = `${this.app.vault.getResourcePath(previewFile)}?v=${previewFile.stat.mtime}`;
		this.renderPreviewImage({
			targetEl: contentEl,
			previewUrl,
			imageClass: PREVIEW_NODE_CLASS,
			hostClass: PREVIEW_NODE_HOST_CLASS,
			alt: `${canvasFile.basename} preview`,
			cacheKey: "canvasAutoupdateNodePreviewUrl"
		});
	}

	private async applyPreviewsInRoot(root: HTMLElement, sourcePath: string, context: RenderContext): Promise<void> {
		const candidates: HTMLElement[] = [];

		if (this.isInternalEmbedElement(root)) {
			candidates.push(root);
		}

		candidates.push(...Array.from(root.querySelectorAll<HTMLElement>(".internal-embed[src], .internal-embed[data-href]")));

		await Promise.all(candidates.map((candidate) => this.applyPreviewToEmbedElement(candidate, sourcePath, context)));
	}

	private isInternalEmbedElement(el: HTMLElement): boolean {
		if (!el.classList.contains("internal-embed")) {
			return false;
		}
		return Boolean(el.getAttribute("src") || el.getAttribute("data-href"));
	}

	private async applyPreviewToEmbedElement(
		embedEl: HTMLElement,
		sourcePath: string,
		context: RenderContext
	): Promise<void> {
		const rawLink = embedEl.getAttribute("src") ?? embedEl.getAttribute("data-href");
		if (!rawLink) {
			return;
		}

		const canvasFile = this.resolveCanvasFile(rawLink, sourcePath);
		if (!canvasFile) {
			return;
		}

		const previewFile = await this.ensurePreviewFile(canvasFile);
		if (!previewFile) {
			return;
		}

		const previewUrl = `${this.app.vault.getResourcePath(previewFile)}?v=${previewFile.stat.mtime}`;
		this.renderPreviewImage({
			targetEl: embedEl,
			previewUrl,
			imageClass: PREVIEW_CLASS,
			hostClass: PREVIEW_HOST_CLASS,
			alt: `${canvasFile.basename} preview`,
			cacheKey: "canvasAutoupdatePreviewUrl",
			context
		});
	}

	private renderPreviewImage(options: PreviewRenderOptions): void {
		const previousUrl = options.targetEl.dataset[options.cacheKey];
		if (previousUrl === options.previewUrl && options.targetEl.querySelector(`img.${options.imageClass}`)) {
			return;
		}

		this.clearElement(options.targetEl);
		options.targetEl.dataset[options.cacheKey] = options.previewUrl;
		options.targetEl.classList.add(options.hostClass);

		if (options.context) {
			options.targetEl.classList.toggle("canvas-autoupdate-preview-note", options.context === "note");
			options.targetEl.classList.toggle("canvas-autoupdate-preview-canvas", options.context === "canvas");
		}

		const img = document.createElement("img");
		img.className = options.imageClass;
		img.src = options.previewUrl;
		img.alt = options.alt;
		img.loading = "lazy";
		options.targetEl.appendChild(img);
	}

	private resolveSourcePathForElement(el: HTMLElement, insideCanvasLeaf: boolean): string | null {
		if (insideCanvasLeaf) {
			const canvasLeafRoot = el.closest<HTMLElement>('.workspace-leaf-content[data-type="canvas"]');
			for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
				const view = leaf.view as unknown as CanvasLeafView;
				if (!view.file) {
					continue;
				}
				if (view.canvas?.wrapperEl?.contains(el)) {
					return view.file.path;
				}
				if (view.containerEl?.contains(el)) {
					return view.file.path;
				}
				if (canvasLeafRoot && view.containerEl && (view.containerEl === canvasLeafRoot || view.containerEl.contains(canvasLeafRoot))) {
					return view.file.path;
				}
			}
		} else {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as unknown as MarkdownLeafView;
				if (!view.file || !view.contentEl) {
					continue;
				}
				if (view.contentEl.contains(el)) {
					return view.file.path;
				}
			}
		}

		const activeFile = this.app.workspace.getActiveFile();
		return activeFile?.path ?? null;
	}

	private resolveCanvasFile(rawLink: string, sourcePath: string): TFile | null {
		const linkedFile = this.resolveLinkedFile(rawLink, sourcePath);
		if (linkedFile?.extension.toLowerCase() === "canvas") {
			return linkedFile;
		}

		const linkPath = this.extractLinkPath(rawLink);
		if (!linkPath) {
			return null;
		}

		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
		if (resolved?.extension === "canvas") {
			return resolved;
		}

		if (!linkPath.toLowerCase().endsWith(".canvas")) {
			return null;
		}

		const direct = this.app.vault.getFileByPath(normalizePath(linkPath));
		if (direct && direct.extension === "canvas") {
			return direct;
		}

		return null;
	}

	private schedulePreviewGeneration(canvasPath: string): void {
		const previousTimer = this.generationTimers.get(canvasPath);
		if (previousTimer !== undefined) {
			window.clearTimeout(previousTimer);
		}

		const timer = window.setTimeout(() => {
			this.generationTimers.delete(canvasPath);
			void this.generatePreviewByCanvasPath(canvasPath, false);
		}, this.settings.debounceMs);

		this.generationTimers.set(canvasPath, timer);
	}

	private async ensurePreviewFile(canvasFile: TFile): Promise<TFile | null> {
		const previewPath = this.getPreviewPath(canvasFile.path, this.settings.format);
		const existing = this.app.vault.getFileByPath(previewPath);
		if (existing) {
			return existing;
		}

		return this.generatePreviewByCanvasPath(canvasFile.path, false);
	}

	async regenerateAllPreviews(trigger: "startup" | "manual"): Promise<void> {
		const canvasFiles = this.app.vault.getFiles().filter((file) => file.extension === "canvas");
		let success = 0;
		let failed = 0;

		for (const file of canvasFiles) {
			try {
				const written = await this.generatePreviewByCanvasPath(file.path, false);
				if (written) {
					success += 1;
				}
			} catch (error) {
				failed += 1;
				console.error(`[Embed Canvas] failed to regenerate ${file.path}`, error);
			}
		}

		if (trigger === "manual") {
			new Notice(`Canvas previews regenerated: ${success} succeeded, ${failed} failed.`);
		}
	}

	private async generatePreviewByCanvasPath(canvasPath: string, showNoticeOnSuccess: boolean): Promise<TFile | null> {
		const canvasFile = this.app.vault.getFileByPath(canvasPath);
		if (!canvasFile || canvasFile.extension !== "canvas") {
			return null;
		}

		let parsedData: JsonCanvasData;
		try {
			const raw = await this.app.vault.cachedRead(canvasFile);
			parsedData = this.parseCanvas(raw, canvasFile.path);
		} catch (error) {
			console.error(`[Embed Canvas] unable to parse ${canvasFile.path}`, error);
			new Notice(`Unable to parse canvas: ${canvasFile.path}`);
			return null;
		}

		const imageBuffer = await this.renderCanvasToImage(parsedData, canvasFile.path);
		const previewPath = this.getPreviewPath(canvasFile.path, this.settings.format);
		const folderPath = this.dirname(previewPath);
		await this.ensureFolderExists(folderPath);

		const existingPreview = this.app.vault.getFileByPath(previewPath);
		let written: TFile;
		if (existingPreview) {
			await this.app.vault.modifyBinary(existingPreview, imageBuffer);
			written = existingPreview;
		} else {
			written = await this.app.vault.createBinary(previewPath, imageBuffer);
		}

		await this.deleteOtherFormatPreviews(canvasFile.path, previewPath);
		this.scheduleEmbedRefresh();

		if (showNoticeOnSuccess) {
			new Notice(`Canvas preview regenerated: ${canvasFile.basename}`);
		}

		return written;
	}

	private parseCanvas(raw: string, canvasPath: string): JsonCanvasData {
		const parsed = JSON.parse(raw) as JsonCanvasData;
		const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter((node) => this.isValidNode(node, canvasPath)) : [];
		const edges = Array.isArray(parsed.edges) ? parsed.edges.filter((edge) => this.isValidEdge(edge, canvasPath)) : [];
		return { nodes, edges };
	}

	private isValidNode(node: JsonCanvasNode, canvasPath: string): boolean {
		const valid =
			typeof node?.id === "string" &&
			typeof node?.type === "string" &&
			typeof node?.x === "number" &&
			typeof node?.y === "number" &&
			typeof node?.width === "number" &&
			typeof node?.height === "number";

		if (!valid) {
			console.warn(`[Embed Canvas] invalid node in ${canvasPath}`, node);
		}
		return valid;
	}

	private isValidEdge(edge: JsonCanvasEdge, canvasPath: string): boolean {
		const valid =
			typeof edge?.id === "string" &&
			typeof edge?.fromNode === "string" &&
			typeof edge?.toNode === "string";

		if (!valid) {
			console.warn(`[Embed Canvas] invalid edge in ${canvasPath}`, edge);
		}
		return valid;
	}

	private createRenderState(_sourcePath: string, depth: number): CanvasRenderState {
		return { depth };
	}

	private async renderCanvasToImage(
		data: JsonCanvasData,
		sourcePath: string,
		renderState: CanvasRenderState = this.createRenderState(sourcePath, 0)
	): Promise<ArrayBuffer> {
		const nodes = data.nodes ?? [];
		const edges = data.edges ?? [];
		const bounds = this.computeBounds(nodes);
		const padding = 16;

		const worldWidth = Math.max(1, bounds.width + padding * 2);
		const worldHeight = Math.max(1, bounds.height + padding * 2);
		const fitScale = Math.min(1, this.settings.maxDimension / Math.max(worldWidth, worldHeight));
		const renderScale = Math.max(0.2, fitScale * this.settings.pixelRatio);

		const pixelWidth = Math.max(1, Math.round(worldWidth * renderScale));
		const pixelHeight = Math.max(1, Math.round(worldHeight * renderScale));

		const canvas = document.createElement("canvas");
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Could not create canvas rendering context");
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, pixelWidth, pixelHeight);

		ctx.scale(renderScale, renderScale);
		ctx.translate(-bounds.minX + padding, -bounds.minY + padding);

		const nodeById = new Map<string, JsonCanvasNode>();
		for (const node of nodes) {
			nodeById.set(node.id, node);
		}

		this.drawEdges(ctx, edges, nodeById);
		await this.drawNodes(ctx, nodes, sourcePath, renderState);

		const blob = await this.canvasToBlob(canvas, PREVIEW_MIME[this.settings.format], this.settings.quality);
		return blob.arrayBuffer();
	}

	private drawEdges(ctx: CanvasRenderingContext2D, edges: JsonCanvasEdge[], nodeById: Map<string, JsonCanvasNode>): void {
		ctx.lineWidth = 2;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		for (const edge of edges) {
			const fromNode = nodeById.get(edge.fromNode);
			const toNode = nodeById.get(edge.toNode);
			if (!fromNode || !toNode) {
				continue;
			}

			const fromPoint = this.getAnchorPoint(fromNode, edge.fromSide);
			const toPoint = this.getAnchorPoint(toNode, edge.toSide);
			const color = this.resolveCanvasColor(edge.color, "#9aa4bd");

			ctx.strokeStyle = color;
			ctx.beginPath();
			ctx.moveTo(fromPoint.x, fromPoint.y);
			ctx.lineTo(toPoint.x, toPoint.y);
			ctx.stroke();

			this.drawArrowHead(ctx, fromPoint.x, fromPoint.y, toPoint.x, toPoint.y, color);

			if (edge.label) {
				const midX = (fromPoint.x + toPoint.x) / 2;
				const midY = (fromPoint.y + toPoint.y) / 2;
				ctx.font = "12px Inter, Arial, sans-serif";
				const textWidth = ctx.measureText(edge.label).width;
				ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
				ctx.fillRect(midX - textWidth / 2 - 6, midY - 11, textWidth + 12, 18);
				ctx.fillStyle = "#1f2937";
				ctx.fillText(edge.label, midX - textWidth / 2, midY + 3);
			}
		}
	}

	private async drawNodes(
		ctx: CanvasRenderingContext2D,
		nodes: JsonCanvasNode[],
		sourcePath: string,
		renderState: CanvasRenderState
	): Promise<void> {
		for (const node of nodes) {
			if (node.type === "file") {
				const renderedImage = await this.drawFileNodeImage(ctx, node, sourcePath, renderState);
				if (renderedImage) {
					ctx.strokeStyle = "rgba(15, 23, 42, 0.22)";
					ctx.lineWidth = 1;
					this.drawRoundedRect(ctx, node.x, node.y, node.width, node.height, 10);
					ctx.stroke();
					continue;
				}
			}

			const baseColor = this.resolveNodeColor(node);
			const fillColor = this.withAlpha(baseColor, 0.2);
			const borderColor = this.withAlpha(baseColor, 0.85);
			const radius = node.type === "group" ? 14 : 10;

			ctx.fillStyle = fillColor;
			ctx.strokeStyle = borderColor;
			ctx.lineWidth = node.type === "group" ? 1.6 : 1.2;

			if (node.type === "group") {
				ctx.setLineDash([8, 6]);
			} else {
				ctx.setLineDash([]);
			}

			this.drawRoundedRect(ctx, node.x, node.y, node.width, node.height, radius);
			ctx.fill();
			ctx.stroke();

			ctx.setLineDash([]);
			ctx.fillStyle = "#1f2937";
			ctx.font = "13px Inter, Arial, sans-serif";

			const content = this.nodePreviewText(node);
			this.drawWrappedText(ctx, content, node.x + 12, node.y + 24, node.width - 24, node.height - 18, 16, 5);
		}
	}

	private async drawFileNodeImage(
		ctx: CanvasRenderingContext2D,
		node: JsonCanvasNode,
		sourcePath: string,
		renderState: CanvasRenderState
	): Promise<boolean> {
		const rawPath = node.file?.trim();
		if (!rawPath) {
			return false;
		}

		const linkedFile = this.resolveLinkedFile(rawPath, sourcePath);
		if (!linkedFile) {
			console.debug(`[Embed Canvas] unresolved file node: ${rawPath}`);
			return false;
		}

		if (this.isImageFile(linkedFile)) {
			try {
				const bitmap = await this.loadVaultImageBitmap(linkedFile);
				try {
					this.drawImageInNodeBounds(ctx, node, bitmap);
				} finally {
					bitmap.close();
				}
				return true;
			} catch (error) {
				console.warn(`[Embed Canvas] failed to render image node ${rawPath}`, error);
				return false;
			}
		}

		if (linkedFile.extension.toLowerCase() === "canvas") {
			return this.drawNestedCanvasNodeImage(ctx, node, linkedFile, renderState);
		}

		console.debug(`[Embed Canvas] unsupported file node type: ${rawPath}`);
		return false;
	}

	private drawImageInNodeBounds(ctx: CanvasRenderingContext2D, node: JsonCanvasNode, bitmap: ImageBitmap): void {
		const clipX = node.x;
		const clipY = node.y;
		const clipWidth = Math.max(1, node.width);
		const clipHeight = Math.max(1, node.height);
		const clipRadius = Math.max(0, Math.min(10, clipWidth / 2, clipHeight / 2));

		ctx.save();
		try {
			this.drawRoundedRect(ctx, clipX, clipY, clipWidth, clipHeight, clipRadius);
			ctx.clip();

			ctx.fillStyle = "#ffffff";
			ctx.fillRect(clipX, clipY, clipWidth, clipHeight);

			const imageWidth = Math.max(1, bitmap.width || clipWidth);
			const imageHeight = Math.max(1, bitmap.height || clipHeight);
			const scale = Math.max(clipWidth / imageWidth, clipHeight / imageHeight);
			const drawWidth = imageWidth * scale;
			const drawHeight = imageHeight * scale;
			const drawX = clipX + (clipWidth - drawWidth) / 2;
			const drawY = clipY + (clipHeight - drawHeight) / 2;
			ctx.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight);
		} finally {
			ctx.restore();
		}
	}

	private async drawNestedCanvasNodeImage(
		ctx: CanvasRenderingContext2D,
		node: JsonCanvasNode,
		canvasFile: TFile,
		renderState: CanvasRenderState
	): Promise<boolean> {
		if (renderState.depth >= this.settings.maxCanvasEmbedDepth) {
			return false;
		}

		try {
			const raw = await this.app.vault.cachedRead(canvasFile);
			const parsedData = this.parseCanvas(raw, canvasFile.path);
			const nestedState = this.createRenderState(canvasFile.path, renderState.depth + 1);
			const nestedBuffer = await this.renderCanvasToImage(parsedData, canvasFile.path, nestedState);
			const nestedBlob = new Blob([nestedBuffer], { type: PREVIEW_MIME[this.settings.format] });
			const nestedBitmap = await createImageBitmap(nestedBlob);
			try {
				this.drawImageInNodeBounds(ctx, node, nestedBitmap);
			} finally {
				nestedBitmap.close();
			}
			return true;
		} catch (error) {
			console.warn(`[Embed Canvas] failed to render nested canvas node ${canvasFile.path}`, error);
			return false;
		}
	}

	private resolveLinkedFile(rawPath: string, sourcePath: string): TFile | null {
		const linkPath = this.extractLinkPath(rawPath);
		if (!linkPath) {
			return null;
		}

		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
		if (resolved instanceof TFile) {
			return resolved;
		}

		const candidates = new Set<string>();
		candidates.add(linkPath);

		const withoutLeadingSlash = linkPath.replace(/^\/+/, "");
		if (withoutLeadingSlash) {
			candidates.add(normalizePath(withoutLeadingSlash));
		}

		if (!/^[a-z]+:\/\//i.test(linkPath)) {
			const sourceDir = this.dirname(sourcePath);
			candidates.add(normalizePath(`${sourceDir}/${linkPath}`));
		}

		for (const candidate of candidates) {
			const found = this.app.vault.getFileByPath(candidate);
			if (found) {
				return found;
			}
		}

		// Last resort for ambiguous relative links that metadata cache has not resolved yet.
		const byName = this.app.vault.getFiles().filter((file) => file.name.toLowerCase() === this.basename(linkPath).toLowerCase());
		if (byName.length === 1) {
			return byName[0];
		}

		return null;
	}

	private isImageFile(file: TFile): boolean {
		return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"].includes(file.extension.toLowerCase());
	}

	private async loadVaultImageBitmap(file: TFile): Promise<ImageBitmap> {
		const data = await this.app.vault.readBinary(file);
		const blob = new Blob([data], { type: this.imageMimeType(file.extension) });
		return createImageBitmap(blob);
	}

	private imageMimeType(extension: string): string {
		const normalized = extension.toLowerCase();
		const map: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			webp: "image/webp",
			gif: "image/gif",
			bmp: "image/bmp",
			svg: "image/svg+xml",
			avif: "image/avif"
		};
		return map[normalized] ?? "application/octet-stream";
	}

	private extractLinkPath(rawLink: string): string | null {
		let cleaned = rawLink.trim();
		if (!cleaned) {
			return null;
		}

		if (cleaned.startsWith("![[") && cleaned.endsWith("]]")) {
			cleaned = cleaned.slice(3, -2);
		} else if (cleaned.startsWith("[[") && cleaned.endsWith("]]")) {
			cleaned = cleaned.slice(2, -2);
		}

		cleaned = cleaned.split("|")[0]?.trim() ?? "";
		cleaned = cleaned.split("#")[0]?.trim() ?? "";
		if (!cleaned) {
			return null;
		}

		const withoutLeadingSlash = cleaned.replace(/^\/+/, "");
		try {
			return normalizePath(decodeURIComponent(withoutLeadingSlash));
		} catch {
			return normalizePath(withoutLeadingSlash);
		}
	}

	private nodePreviewText(node: JsonCanvasNode): string {
		if (node.type === "text") {
			return (node.text ?? "").trim() || "Text node";
		}
		if (node.type === "file") {
			const fileName = node.file ? this.basename(node.file) : "File";
			return `File: ${fileName}`;
		}
		if (node.type === "link") {
			return `Link: ${(node.url ?? "").trim() || "URL"}`;
		}
		return `Group: ${(node.label ?? "").trim() || "Group"}`;
	}

	private drawWrappedText(
		ctx: CanvasRenderingContext2D,
		text: string,
		x: number,
		y: number,
		width: number,
		height: number,
		lineHeight: number,
		maxLines: number
	): void {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) {
			return;
		}

		const words = normalized.split(" ");
		const lines: string[] = [];
		let current = "";

		for (const word of words) {
			const candidate = current ? `${current} ${word}` : word;
			if (ctx.measureText(candidate).width <= width) {
				current = candidate;
				continue;
			}

			if (current) {
				lines.push(current);
				if (lines.length >= maxLines) {
					break;
				}
			}
			current = word;
		}

		if (lines.length < maxLines && current) {
			lines.push(current);
		}

		if (lines.length > maxLines) {
			lines.length = maxLines;
		}

		const drawableLines = Math.min(lines.length, Math.max(1, Math.floor(height / lineHeight)));
		for (let i = 0; i < drawableLines; i += 1) {
			let line = lines[i];
			if (i === drawableLines - 1 && i < lines.length - 1) {
				line = `${line.slice(0, Math.max(0, line.length - 1))}…`;
			}
			ctx.fillText(line, x, y + i * lineHeight);
		}
	}

	private drawRoundedRect(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number
	): void {
		const r = Math.max(0, Math.min(radius, width / 2, height / 2));
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + width - r, y);
		ctx.quadraticCurveTo(x + width, y, x + width, y + r);
		ctx.lineTo(x + width, y + height - r);
		ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
		ctx.lineTo(x + r, y + height);
		ctx.quadraticCurveTo(x, y + height, x, y + height - r);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
		ctx.closePath();
	}

	private drawArrowHead(
		ctx: CanvasRenderingContext2D,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		color: string
	): void {
		const angle = Math.atan2(y2 - y1, x2 - x1);
		const size = 8;

		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(x2, y2);
		ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7));
		ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7));
		ctx.closePath();
		ctx.fill();
	}

	private getAnchorPoint(node: JsonCanvasNode, side: "top" | "right" | "bottom" | "left" | undefined): { x: number; y: number } {
		if (side === "top") {
			return { x: node.x + node.width / 2, y: node.y };
		}
		if (side === "right") {
			return { x: node.x + node.width, y: node.y + node.height / 2 };
		}
		if (side === "bottom") {
			return { x: node.x + node.width / 2, y: node.y + node.height };
		}
		if (side === "left") {
			return { x: node.x, y: node.y + node.height / 2 };
		}
		return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
	}

	private computeBounds(nodes: JsonCanvasNode[]): Bounds {
		if (nodes.length === 0) {
			return {
				minX: 0,
				minY: 0,
				maxX: 480,
				maxY: 320,
				width: 480,
				height: 320
			};
		}

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const node of nodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x + node.width);
			maxY = Math.max(maxY, node.y + node.height);
		}

		return {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY
		};
	}

	private resolveNodeColor(node: JsonCanvasNode): string {
		if (node.color) {
			return this.resolveCanvasColor(node.color, "#8ab4ff");
		}

		if (node.type === "text") {
			return "#8ab4ff";
		}
		if (node.type === "file") {
			return "#8ed39b";
		}
		if (node.type === "link") {
			return "#ffd27d";
		}
		return "#c6b0ff";
	}

	private resolveCanvasColor(rawColor: string | undefined, fallback: string): string {
		if (!rawColor) {
			return fallback;
		}
		if (rawColor.startsWith("#")) {
			return rawColor;
		}

		const preset: Record<string, string> = {
			"1": "#ef6c6c",
			"2": "#f6a04d",
			"3": "#f2cb5c",
			"4": "#5ecb86",
			"5": "#53bfd4",
			"6": "#ad8cf0"
		};
		return preset[rawColor] ?? fallback;
	}

	private withAlpha(color: string, alpha: number): string {
		const normalized = color.replace("#", "");
		const clean = normalized.length === 3
			? normalized
					.split("")
					.map((char) => char + char)
					.join("")
			: normalized;

		if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
			return color;
		}

		const r = Number.parseInt(clean.slice(0, 2), 16);
		const g = Number.parseInt(clean.slice(2, 4), 16);
		const b = Number.parseInt(clean.slice(4, 6), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	private canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error("Failed to encode preview image"));
					return;
				}
				resolve(blob);
			}, mimeType, quality);
		});
	}

	private getPreviewPath(canvasPath: string, format: PreviewFormat): string {
		const hash = this.hashString(canvasPath);
		const baseName = this.basenameWithoutExtension(canvasPath);
		const fileName = `${this.safeFileStem(baseName)}-${hash}.${format}`;
		const previewFolder = this.getPreviewFolderPath();
		return `${previewFolder}/${fileName}`;
	}

	private async deleteOtherFormatPreviews(canvasPath: string, keepPath: string): Promise<void> {
		const formats: PreviewFormat[] = ["png", "jpg", "webp"];
		for (const format of formats) {
			const candidatePath = this.getPreviewPath(canvasPath, format);
			if (candidatePath === keepPath) {
				continue;
			}
			const file = this.app.vault.getFileByPath(candidatePath);
			if (file) {
				await this.app.vault.delete(file, true);
			}
		}
	}

	private async deletePreviewSetForCanvasPath(canvasPath: string): Promise<void> {
		const formats: PreviewFormat[] = ["png", "jpg", "webp"];
		for (const format of formats) {
			const file = this.app.vault.getFileByPath(this.getPreviewPath(canvasPath, format));
			if (file) {
				await this.app.vault.delete(file, true);
			}
		}
	}

	private async ensureFolderExists(path: string): Promise<void> {
		if (!path) {
			return;
		}

		const parts = normalizePath(path).split("/").filter(Boolean);
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
				continue;
			}

			if (!(existing instanceof TFolder)) {
				throw new Error(`Expected folder at ${current}, but found a file.`);
			}
		}
	}

	private isCanvasFile(file: TAbstractFile): file is TFile {
		return file instanceof TFile && file.extension === "canvas";
	}

	private isCanvasAbstractFile(file: TAbstractFile): file is TAbstractFile & { path: string } {
		return typeof file.path === "string" && file.path.toLowerCase().endsWith(".canvas");
	}

	private basename(path: string): string {
		const split = path.split("/");
		return split[split.length - 1] ?? path;
	}

	private basenameWithoutExtension(path: string): string {
		const name = this.basename(path);
		const index = name.lastIndexOf(".");
		return index >= 0 ? name.slice(0, index) : name;
	}

	private dirname(path: string): string {
		const index = path.lastIndexOf("/");
		return index >= 0 ? path.slice(0, index) : "";
	}

	private safeFileStem(input: string): string {
		const collapsed = input.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
		return collapsed.replace(/^-+|-+$/g, "") || "canvas";
	}

	private hashString(input: string): string {
		let hash = 0;
		for (let i = 0; i < input.length; i += 1) {
			hash = (hash << 5) - hash + input.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash).toString(36);
	}

	private clearElement(element: HTMLElement): void {
		while (element.firstChild) {
			element.removeChild(element.firstChild);
		}
	}
}

class CanvasAutoupdatePreviewSettingsTab extends PluginSettingTab {
	private plugin: CanvasAutoupdatePreviewsPlugin;

	constructor(app: App, plugin: CanvasAutoupdatePreviewsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Embed Canvas" });

		new Setting(containerEl)
			.setName("Preview folder")
			.setDesc("Folder in your vault where generated canvas thumbnails are stored.")
			.addText((text) =>
				text
					.setPlaceholder("canvas-previews")
					.setValue(this.plugin.settings.previewFolder)
					.onChange(async (value) => {
						const next =
							normalizePath(value.trim() || DEFAULT_SETTINGS.previewFolder).replace(/^\/+|\/+$/g, "") ||
							DEFAULT_SETTINGS.previewFolder;
						this.plugin.settings.previewFolder = next;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hide preview folder in file explorer")
			.setDesc("Keeps preview files in a normal folder name while hiding that folder in Obsidian's file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hidePreviewFolderInFileExplorer)
					.onChange(async (value) => {
						this.plugin.settings.hidePreviewFolderInFileExplorer = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-exclude preview folder")
			.setDesc("Automatically add the preview folder to Files & Links > Excluded files.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoExcludePreviewFolder)
					.onChange(async (value) => {
						this.plugin.settings.autoExcludePreviewFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Image format")
			.setDesc("PNG is best for diagrams and text. JPG/WebP are smaller.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("png", "PNG (recommended)")
					.addOption("jpg", "JPG")
					.addOption("webp", "WebP")
					.setValue(this.plugin.settings.format)
					.onChange(async (value) => {
						this.plugin.settings.format = value as PreviewFormat;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Compression quality")
			.setDesc("Used by JPG and WebP encoders (0.1 to 1.0).")
			.addSlider((slider) =>
				slider
					.setLimits(10, 100, 5)
					.setValue(Math.round(this.plugin.settings.quality * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.quality = value / 100;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum dimension")
			.setDesc("Largest width/height for a generated preview, in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(600, 5000, 100)
					.setValue(this.plugin.settings.maxDimension)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxDimension = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Render scale")
			.setDesc("Higher values increase thumbnail clarity and file size.")
			.addSlider((slider) =>
				slider
					.setLimits(10, 250, 5)
					.setValue(Math.round(this.plugin.settings.pixelRatio * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pixelRatio = value / 100;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Regeneration debounce")
			.setDesc("Wait time after a canvas change before regenerating its thumbnail.")
			.addSlider((slider) =>
				slider
					.setLimits(100, 5000, 100)
					.setValue(this.plugin.settings.debounceMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.debounceMs = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Replace canvas embeds in notes")
			.setDesc("Shows generated image previews for ![[something.canvas]] in notes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderInNotes).onChange(async (value) => {
					this.plugin.settings.renderInNotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Replace canvas embeds inside canvas cards")
			.setDesc("Shows generated image previews for nested canvas cards.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderInCanvas).onChange(async (value) => {
					this.plugin.settings.renderInCanvas = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Nested canvas depth limit")
			.setDesc("Maximum depth for rendering canvas files inside canvas files to prevent recursive loops.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 8, 1)
					.setValue(this.plugin.settings.maxCanvasEmbedDepth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxCanvasEmbedDepth = Math.max(0, Math.round(value));
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Regenerate previews on startup")
			.setDesc("When enabled, all canvas previews are refreshed after Obsidian loads.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.regenerateOnStartup).onChange(async (value) => {
					this.plugin.settings.regenerateOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Regenerate now")
			.setDesc("Manually rebuild all preview images.")
			.addButton((button) =>
				button.setButtonText("Regenerate all").onClick(() => {
					void this.plugin.regenerateAllPreviews("manual");
				})
			);
	}
}
