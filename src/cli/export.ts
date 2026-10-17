import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readManifest } from './read-report';
import { jsonForScript } from './script-json';

/**
 * Single-file export (ROADMAP.md: opt-in, never the primary format): inlines
 * the SPA bundle, all data chunks, latin fonts, and a budgeted set of image
 * attachments into one self-contained HTML file. Videos and traces become
 * omitted stubs. `failuresOnly` additionally strips passing tests from the
 * list/detail data (run stats stay intact, the UI shows a banner).
 */

export interface ExportOptions {
  failuresOnly?: boolean;
  /** Total inline-attachment budget in bytes (default 10 MB). */
  inlineBudget?: number;
}

const HARD_WARN_BYTES = 50 * 1024 * 1024;
const FAILING = new Set([1, 2]); // TEST_OUTCOMES indexes: unexpected, flaky

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

function parseChunk(source: string): unknown {
  return JSON.parse(source.slice(source.indexOf(', ') + 2, source.lastIndexOf(');')));
}

function toInline(key: string, data: unknown): string {
  return `<script>window.__BEACON__.push(${jsonForScript(key)}, ${jsonForScript(data)});</script>`;
}

async function listChunks(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.js')).sort();
  } catch {
    return [];
  }
}

interface IndexChunk {
  [column: string]: unknown[];
  outcome: number[];
}

function filterColumnar(chunk: IndexChunk, keep: (row: number) => boolean): IndexChunk {
  const rows = chunk.outcome.map((_, i) => i).filter(keep);
  const out: IndexChunk = { outcome: [] };
  for (const [column, values] of Object.entries(chunk)) {
    out[column] = rows.map((r) => values[r]);
  }
  return out as IndexChunk;
}

export async function exportSingleFile(
  reportDir: string,
  outFile: string,
  options: ExportOptions = {},
): Promise<{ bytes: number; inlinedAttachments: number }> {
  const budget = options.inlineBudget ?? 10 * 1024 * 1024;
  const manifestSource = await readManifest(reportDir);

  // 1. The SPA bundle. A foreign index.html means the report is beacon.html.
  let indexHtml = '';
  try {
    indexHtml = await readFile(path.join(reportDir, 'index.html'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const beaconPage =
    indexHtml.includes('beacon-cypress-report') ||
    indexHtml.includes('window.__BEACON__') ||
    indexHtml.includes('window.__REPORT__');
  if (!beaconPage) indexHtml = await readFile(path.join(reportDir, 'beacon.html'), 'utf8');
  const jsName = indexHtml.match(/assets\/index-[\w-]+\.js/)?.[0];
  const cssName = indexHtml.match(/assets\/index-[\w-]+\.css/)?.[0];
  if (!jsName || !cssName) {
    throw new Error(`${reportDir} does not look like a beacon report (no hashed bundle found)`);
  }
  const js = await readFile(path.join(reportDir, jsName), 'utf8');
  let css = await readFile(path.join(reportDir, cssName), 'utf8');

  // Inline latin woff2 fonts (small); other subsets fall back down the stack.
  // Vite emits font urls relative to the CSS file (url(./name.woff2)).
  for (const match of [...css.matchAll(/url\((["']?)([^)"']+\.woff2)\1\)/g)]) {
    const url = match[2] ?? '';
    if (!/-latin-\d/.test(url)) continue;
    const rel = url.replace(/^\.?\//, '');
    const file = rel.startsWith('assets/')
      ? path.join(reportDir, rel)
      : path.join(reportDir, 'assets', rel);
    try {
      const body = await readFile(file);
      css = css.replaceAll(match[0], `url(data:font/woff2;base64,${body.toString('base64')})`);
    } catch {
      // Missing font file — the fallback stack covers it.
    }
  }

  // 2. Data chunks (optionally filtered to failures).
  const dataDir = path.join(reportDir, 'data');
  const manifest = parseChunk(manifestSource) as {
    chunks: { index: number; details: number };
    [k: string]: unknown;
  };

  const indexChunks: IndexChunk[] = [];
  for (const name of await listChunks(path.join(dataDir, 'index'))) {
    indexChunks.push(
      parseChunk(await readFile(path.join(dataDir, 'index', name), 'utf8')) as IndexChunk,
    );
  }
  type Detail = {
    outcome: string;
    results: Array<{ attachments: Array<Record<string, unknown>> }>;
  };
  let details: Detail[] = [];
  for (const name of await listChunks(path.join(dataDir, 'details'))) {
    details.push(
      ...(parseChunk(await readFile(path.join(dataDir, 'details', name), 'utf8')) as Detail[]),
    );
  }

  let finalIndexChunks = indexChunks;
  if (options.failuresOnly) {
    details = details.filter((d) => d.outcome === 'unexpected' || d.outcome === 'flaky');
    finalIndexChunks = indexChunks
      .map((chunk) => filterColumnar(chunk, (row) => FAILING.has(chunk.outcome[row] ?? 0)))
      .filter((chunk) => chunk.outcome.length > 0)
      // Repacked details all live in one inline chunk.
      .map((chunk) => ({ ...chunk, detailsChunk: chunk.outcome.map(() => 0) }));
    manifest.chunks = { index: finalIndexChunks.length, details: details.length > 0 ? 1 : 0 };
  }

  const dataScripts = [
    toInline('manifest', manifest),
    ...finalIndexChunks.map((chunk, i) => toInline(`index/chunk-${i}`, chunk)),
    ...(options.failuresOnly
      ? details.length > 0
        ? [toInline('details/chunk-0', details)]
        : []
      : await Promise.all(
          (await listChunks(path.join(dataDir, 'details'))).map(async (name, i) =>
            toInline(
              `details/chunk-${i}`,
              parseChunk(await readFile(path.join(dataDir, 'details', name), 'utf8')),
            ),
          ),
        )),
  ];
  for (const optional of ['history', 'compare', 'errors', 'timeline']) {
    try {
      const chunk = await readFile(path.join(dataDir, `${optional}.js`), 'utf8');
      dataScripts.push(toInline(optional, parseChunk(chunk)));
    } catch {
      // Optional chunk absent (history disabled / first run) — fine.
    }
  }

  // 3. Image attachments up to the budget, largest-value first (report order).
  const inline: Record<string, string> = {};
  let spent = 0;
  for (const detail of details) {
    for (const result of detail.results) {
      for (const att of result.attachments) {
        const sha = att.sha256 as string | undefined;
        const contentType = String(att.contentType ?? '');
        const ext = String(att.ext ?? '');
        if (!sha || inline[sha] || !contentType.startsWith('image/')) continue;
        const file = path.join(reportDir, 'attachments', `${sha}.${ext}`);
        try {
          const size = (await stat(file)).size;
          if (spent + size > budget) continue;
          inline[sha] =
            `data:${MIME[ext] ?? contentType};base64,${(await readFile(file)).toString('base64')}`;
          spent += size;
        } catch {
          // Attachment missing on disk — stays an omitted stub.
        }
      }
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Beacon Report</title>
<script>
try {
  const stored = localStorage.getItem('beacon-theme');
  const dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
} catch {}
window.__BEACON_SINGLE_FILE__ = true;
${options.failuresOnly ? "window.__BEACON_VARIANT__ = 'failures';\n" : ''}window.__BEACON_PRELOADED__ = {};
window.__BEACON__ = { push: function (k, d) { window.__BEACON_PRELOADED__[k] = d; } };
window.__BEACON_INLINE_ATTACHMENTS__ = ${jsonForScript(inline)};
</script>
${dataScripts.join('\n')}
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
${js}
</script>
</body>
</html>
`;

  await writeFile(outFile, html, 'utf8');
  const bytes = Buffer.byteLength(html);
  if (bytes > HARD_WARN_BYTES) {
    console.warn(
      `[beacon] Exported file is ${(bytes / 1024 / 1024).toFixed(0)} MB — browsers degrade badly past 50 MB. Prefer the multi-file report.`,
    );
  }
  return { bytes, inlinedAttachments: Object.keys(inline).length };
}
