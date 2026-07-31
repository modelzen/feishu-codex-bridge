import { defineConfig } from 'tsup';

// @anthropic-ai/claude-agent-sdk 是「按需下载」后端依赖（不在 dependencies，故 tsup
// 默认会把它打进 dist）——显式外置：dist 只保留运行时 import，真正加载走 loadBackendDep
// （桥/全局/用户私装目录三路探测），未装则 Web 出「下载」按钮。
const external = ['@anthropic-ai/claude-agent-sdk'];

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    external,
  },
  {
    entry: {
      index: 'src/index.ts',
      runtime: 'src/runtime/index.ts',
    },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
    external,
  },
]);
