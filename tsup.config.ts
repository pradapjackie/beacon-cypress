import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/support.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  esbuildOptions(options) {
    options.loader = { ...options.loader, '.styles': 'text', '.client': 'text' };
  },
});
