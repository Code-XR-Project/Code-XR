// Production build of the IDE into out/. Usage: node scripts/build.mjs
import { build } from 'vite';
import { nodeTargetConfig, rendererConfig } from './viteConfigs.mjs';

await build(nodeTargetConfig('main'));
await build(nodeTargetConfig('preload'));
await build(rendererConfig());
console.log('[code-xr-ide] built into apps/ide/out/');
