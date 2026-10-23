// Stage only the static frontend assets into src-tauri/web so repository
// metadata, scan results, node_modules, and tokens are never bundled into .exe.
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "src-tauri/web");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const item of ["index.html", "css", "js"]) {
  await cp(resolve(root, item), resolve(destination, item), { recursive: true });
}

console.log("Staged static UI assets in src-tauri/web");
