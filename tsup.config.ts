import { defineConfig } from 'tsup';

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
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
]);
