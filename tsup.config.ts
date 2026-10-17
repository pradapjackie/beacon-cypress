import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      support: 'src/support.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    shims: true,
    target: 'node20',
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.styles': 'text', '.client': 'text' };
    },
  },
  {
    entry: {
      cli: 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    target: 'node20',
    external: ['@playwright/test'],
  },
]);
