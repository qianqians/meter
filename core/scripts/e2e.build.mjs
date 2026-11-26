// esbuild 打包 e2e（Node 18 没有 TS 直跑）：bundle 成 .mjs 再 node 跑
import { build } from 'esbuild';
await build({
  entryPoints: ['scripts/e2e.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'scripts/.e2e.bundle.mjs',
  packages: 'external',
});
