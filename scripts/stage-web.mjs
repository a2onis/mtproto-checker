// Ship only the static UI, never repository metadata or result files.
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'src-tauri/web');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const item of ['index.html', 'css', 'js']) {
  await cp(resolve(root, item), resolve(destination, item), { recursive: true });
}
console.log('Staged static UI in src-tauri/web');
