import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'beacon-text',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('/report.styles') || id.endsWith('/report.client')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`;
        }
      },
    },
  ],
});
