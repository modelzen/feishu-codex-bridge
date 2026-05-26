import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only our own unit tests. Without this, vitest also scans the vendored
    // reference project under docs/references/** (yepanywhere etc.), which has
    // its own deps/runtime and fails to collect.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'docs/**', 'prototype/**'],
  },
});
