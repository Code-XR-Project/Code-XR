// Runs the built IDE (out/) without the dev server. Usage: npm run ide:start
import { spawn } from 'node:child_process';
import { IDE_ROOT } from './viteConfigs.mjs';
import { electronBinary, launchFlags } from './electronBinary.mjs';

const child = spawn(electronBinary(), [...launchFlags(), IDE_ROOT], {
    stdio: 'inherit',
    env: { ...process.env, CODEXR_IDE_DEV_SERVER_URL: '' },
});
child.on('exit', (code) => process.exit(code ?? 0));
