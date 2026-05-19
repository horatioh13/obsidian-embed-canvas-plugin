import fs from "fs";

const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

versions[manifest.version] = manifest.minAppVersion;

fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
