import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serveReport } from './server';

/**
 * PDF export: serve the report on an ephemeral port, render the main pages in
 * headless Chromium with print media, and write one PDF. Uses the consumer's
 * own Playwright install (it's a peer of the reporter, so it's there).
 */
export async function exportPdf(reportDir: string, outFile: string): Promise<{ pages: number }> {
  let chromium: {
    launch: () => Promise<{
      close: () => Promise<void>;
      newPage: () => Promise<{
        emulateMedia: (options: { media: 'print' }) => Promise<void>;
        goto: (url: string, options: { waitUntil: 'networkidle' }) => Promise<unknown>;
        waitForTimeout: (ms: number) => Promise<void>;
        pdf: (options: { path: string; format: 'A4'; printBackground: boolean; margin: Record<string, string> }) => Promise<void>;
      }>;
    }>;
  };
  try {
    const specifier = '@playwright/test';
    const loaded = (await import(specifier)) as { chromium: typeof chromium };
    chromium = loaded.chromium;
  } catch {
    throw new Error('PDF export needs @playwright/test installed in this project.');
  }

  const server = serveReport(reportDir, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.goto(`http://localhost:${port}/#/`, { waitUntil: 'networkidle' });
    // Charts and lazy chunks settle after first paint.
    await page.waitForTimeout(1200);
    await page.pdf({
      path: path.resolve(outFile),
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
    return { pages: 1 };
  } finally {
    await browser.close();
    server.close();
  }
}
