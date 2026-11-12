// Copies the freshly built MaxPortable.exe into build\max-portable\, after
// wiping build\max-portable\ (except the WebView2 profile in data\, so the
// user stays logged in). ESM (package.json has "type": "module").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, "..");
const targetDir = path.join(root, "build", "max-portable");
const dataDir = path.join(targetDir, "data");
const builtExe = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "MaxPortable.exe",
);

if (!fs.existsSync(builtExe)) {
  console.error(
    `[copy-portable] Built exe not found: ${builtExe}\n` +
      `Run "pnpm run build" first (tauri build must succeed).`,
  );
  process.exit(1);
}

// Wipe everything under build\max-portable\ except data\ (WebView2 profile:
// cookies, login, cache). A full wipe would log the user out on every build.
fs.mkdirSync(targetDir, { recursive: true });
for (const entry of fs.readdirSync(targetDir)) {
  if (entry === "data") continue;
  fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
}

// Drop the shortcut marker so ensure_desktop_shortcut() re-creates the .lnk
// with the current name/description. Keeps data\ contents, only resets marker.
// data\ is not created here: WebView2 will create it on first launch.
for (const marker of [".shortcut_created_v2", ".shortcut_created"]) {
  const markerPath = path.join(dataDir, marker);
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath, { force: true });
}

const destExe = path.join(targetDir, "MaxPortable.exe");
fs.copyFileSync(builtExe, destExe);

// Copy the end-user readme next to the exe. Not embedded; re-copied on every
// build because the wipe above removes it.
const readmeSrc = path.join(root, "src-tauri", "readme.txt");
const readmeDest = path.join(targetDir, "readme.txt");
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, readmeDest);
  console.log(`[copy-portable] Copied readme.txt -> ${readmeDest}`);
} else {
  console.warn(`[copy-portable] readme.txt not found at ${readmeSrc}`);
}

const size = fs.statSync(destExe).size;
console.log(
  `[copy-portable] Copied MaxPortable.exe -> ${destExe} (${size} bytes)`,
);
console.log(
  `[copy-portable] build\\max-portable\\ wiped, data\\ preserved (if present).`,
);