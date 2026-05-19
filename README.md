# Embed Canvas

Generate and auto-update image previews for canvas embeds in notes and other canvases.

## How To Install

1. Go to the [latest release](https://github.com/horatioh13/obsidian-embedcanvas-plugin/releases/latest).
2. Download `embed-canvas.zip`.
3. Extract the zip into your vault's plugin folder:
   ```text
   <vault>/.obsidian/plugins/embed-canvas/
   ```
4. Open **Settings → Community plugins** and disable "Safe mode" if prompted.
5. Reload the plugins list and enable **Embed Canvas**.


## Features

- Renders `.canvas` files to image previews (`png`/`jpg`/`webp`).
- Keeps previews synchronized when canvases change.
- Replaces `![[*.canvas]]` embeds in notes with generated preview images.
- Replaces linked `.canvas` file nodes inside canvases with generated preview images.
- Supports nested canvas previews with a configurable depth limit.
- Can hide the preview storage folder in Obsidian's file explorer.
- Can auto-add the preview folder to **Files & Links → Excluded files**.

## Usage

1. Enable the plugin in Obsidian.
2. Open a note or canvas with links to `.canvas` files.
3. Previews are generated automatically and refreshed after canvas edits.
4. Adjust settings from **Settings → Community plugins → Embed Canvas**.

## Screenshots

### Embed canvases in notes
![Embed canvases in notes](assets/readme/embed-canvases-in-notes.jpg)

### Embed canvas inside canvases
This allows for infinite recursion of canvases.

![Embed canvas in canvas](assets/readme/embed-canvas-in-canvas.jpg)

### Auto-update on canvas note changes
This means that when you update your canvas by adding new images, the image in the note automatically updates as well to account for that. 
![Changed canvas note auto-updates](assets/readme/changed-canvas-note-autoupdates.jpg)
