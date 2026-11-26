// Copies the file and folder icons the IDE uses (#138) from the
// material-icon-theme devDependency into src/renderer/public/file-icons/,
// which Vite publishes with the renderer. Only the icons that
// src/renderer/fileIcons.ts can return are copied; the folder is rewritten
// whole, so an icon dropped from the tables leaves no file behind.
//
// Run it after changing the tables or upgrading the package, and commit the
// result: `node scripts/syncFileIcons.mjs` from apps/ide (Node 24 loads the
// .ts module directly). test/fileIcons.test.ts fails while the folder is out
// of step.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { IDE_ROOT } from './viteConfigs.mjs';
import { bundledIconNames } from '../src/renderer/fileIcons.ts';

const require = createRequire(import.meta.url);
const sourceDir = path.join(path.dirname(require.resolve('material-icon-theme/package.json')), 'icons');
const targetDir = path.join(IDE_ROOT, 'src', 'renderer', 'public', 'file-icons');

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
let bytes = 0;
const names = bundledIconNames();
for (const name of names) {
    const file = `${name}.svg`;
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    bytes += fs.statSync(path.join(targetDir, file)).size;
}
console.log(`[code-xr-ide] copied ${names.length} icons (${(bytes / 1024).toFixed(1)} KB) into ${path.relative(IDE_ROOT, targetDir)}`);
