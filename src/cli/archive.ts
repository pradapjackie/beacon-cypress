import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Runs archive: scans a directory whose subdirectories are beacon reports and
 * writes a standalone index.html listing them (for gh-pages style hosting of
 * many runs). No SPA — one small self-contained page.
 */

interface ArchiveRow {
  dir: string;
  title: string;
  startTime: number;
  duration: number;
  status: string;
  counts: { total: number; expected: number; unexpected: number; flaky: number; skipped: number };
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function buildArchive(parentDir: string, outFile: string): Promise<number> {
  const rows: ArchiveRow[] = [];
  for (const entry of await readdir(parentDir)) {
    const manifestPath = path.join(parentDir, entry, 'data', 'manifest.js');
    try {
      if (!(await stat(manifestPath)).isFile()) continue;
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw.slice(raw.indexOf(', ') + 2, raw.lastIndexOf(');'))) as {
        meta: { startTime: number; duration: number; status: string };
        ui?: { title?: string };
        counts: ArchiveRow['counts'];
      };
      rows.push({
        dir: entry,
        title: manifest.ui?.title ?? entry,
        startTime: manifest.meta.startTime,
        duration: manifest.meta.duration,
        status: manifest.meta.status,
        counts: manifest.counts,
      });
    } catch {
      // Not a beacon report — skip.
    }
  }
  rows.sort((a, b) => b.startTime - a.startTime);

  const body = rows
    .map((r) => {
      const rate =
        r.counts.total === 0
          ? 100
          : Math.round(((r.counts.expected + r.counts.flaky) / r.counts.total) * 100);
      const tone = r.status === 'passed' ? '#059669' : '#dc2626';
      return `<a class="row" href="./${encodeURIComponent(r.dir)}/index.html">
  <span class="dot" style="background:${tone}"></span>
  <span class="title">${esc(r.title)}</span>
  <span class="meta">${new Date(r.startTime).toLocaleString()}</span>
  <span class="meta">${r.counts.total} tests</span>
  <span class="meta">${(r.duration / 1000).toFixed(1)}s</span>
  <span class="rate">${rate}%</span>
</a>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Beacon — run archive</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font-family:system-ui,sans-serif;background:#f4f6f8;color:#101828;padding:40px 16px}
@media(prefers-color-scheme:dark){body{background:#0e1420;color:#e8edf4}.row{background:#151d2b;border-color:#232f45}.meta{color:#8896ab}}
main{max-width:860px;margin:0 auto}
h1{font-size:20px}
.row{display:flex;gap:14px;align-items:center;padding:14px 18px;margin:8px 0;background:#fff;border:1px solid #e5e9ef;border-radius:12px;text-decoration:none;color:inherit}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.title{font-weight:600;flex-grow:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:#64748b;font-size:13px;white-space:nowrap}
.rate{font-family:ui-monospace,monospace;font-weight:600}
</style>
</head>
<body>
<main>
<h1>Beacon — run archive</h1>
<p class="meta">${rows.length} reports</p>
${body}
</main>
</body>
</html>
`;
  await writeFile(outFile, html, 'utf8');
  return rows.length;
}
