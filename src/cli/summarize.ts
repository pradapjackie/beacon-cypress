import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * AI/PR summary mode (adopted from Allure 3's agent mode): a Markdown digest
 * of a report for pull-request comments and coding agents.
 */

function parseChunk<T>(source: string): T {
  return JSON.parse(source.slice(source.indexOf(', ') + 2, source.lastIndexOf(');'))) as T;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

interface Detail {
  caseId: string;
  title: string;
  projectName: string;
  outcome: string;
  category?: string;
  failingStreak?: number;
  location: { file: string; line: number };
  results: Array<{ errors: Array<{ message: string }> }>;
}

export async function summarize(reportDir: string): Promise<string> {
  const dataDir = path.join(reportDir, 'data');
  const manifest = parseChunk<{
    meta: { status: string; duration: number; startTime: number; playwrightVersion?: string };
    ui?: { title?: string };
    counts: { total: number; expected: number; unexpected: number; flaky: number; skipped: number };
    aggregates: {
      incidents?: Array<{ message: string; tests: Array<{ title: string }> }>;
      slowedDown?: Array<{ title: string; projectName: string; factor: number }>;
    };
  }>(await readFile(path.join(dataDir, 'manifest.js'), 'utf8'));

  let history:
    | {
        runs: unknown[];
        transitions: { added: string[]; fixed: string[]; regressed: string[] };
        mostFailing: Array<{ title: string; projectName: string; failures: number; runs: number }>;
      }
    | undefined;
  try {
    history = parseChunk(await readFile(path.join(dataDir, 'history.js'), 'utf8'));
  } catch {
    // No history — first run or disabled.
  }

  const details: Detail[] = [];
  try {
    for (const name of (await readdir(path.join(dataDir, 'details'))).filter((f) =>
      f.endsWith('.js'),
    )) {
      details.push(
        ...parseChunk<Detail[]>(await readFile(path.join(dataDir, 'details', name), 'utf8')),
      );
    }
  } catch {
    // Details missing — summary still works from the manifest.
  }

  const { counts, meta } = manifest;
  const passRate =
    counts.total === 0 ? 100 : Math.round(((counts.expected + counts.flaky) / counts.total) * 100);
  const lines: string[] = [];
  lines.push(`# ${manifest.ui?.title ?? 'Beacon test report'}`);
  lines.push('');
  lines.push(
    `**${meta.status === 'passed' ? '✅ Passed' : '❌ Failed'}** · ${counts.total} tests · ${passRate}% pass rate · ${(meta.duration / 1000).toFixed(1)}s${meta.playwrightVersion ? ` · Playwright ${meta.playwrightVersion}` : ''}`,
  );
  lines.push('');
  lines.push(
    `| Passed | Failed | Flaky | Skipped |\n|---|---|---|---|\n| ${counts.expected} | ${counts.unexpected} | ${counts.flaky} | ${counts.skipped} |`,
  );

  if (history && history.runs.length > 1) {
    const t = history.transitions;
    lines.push('');
    lines.push(
      `**vs previous run:** ${t.regressed.length} regressed · ${t.fixed.length} fixed · ${t.added.length} new`,
    );
  }

  const failed = details.filter((d) => d.outcome === 'unexpected');
  if (failed.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const test of failed.slice(0, 15)) {
      const error = (test.results.flatMap((r) => r.errors)[0]?.message ?? '')
        .replace(ANSI, '')
        .split('\n')[0];
      lines.push('');
      lines.push(
        `- **${test.title}** (${test.projectName}) — \`${test.location.file}:${test.location.line}\`${test.category ? ` · ${test.category}` : ''}${test.failingStreak ? ` · failing ${test.failingStreak} runs` : ''}`,
      );
      if (error) lines.push(`  - \`${error}\``);
      lines.push(
        `  - rerun: \`npx cypress run --spec ${test.location.file}${test.projectName ? ` --browser ${test.projectName}` : ''}\``,
      );
    }
    if (failed.length > 15) lines.push(`- …and ${failed.length - 15} more`);
  }

  const incidents = manifest.aggregates.incidents ?? [];
  if (incidents.length > 0) {
    lines.push('');
    lines.push('## Probable common causes');
    for (const incident of incidents) {
      lines.push(`- ${incident.tests.length} tests: \`${incident.message}\``);
    }
  }

  const slowed = manifest.aggregates.slowedDown ?? [];
  if (slowed.length > 0) {
    lines.push('');
    lines.push('## Slowed down');
    for (const s of slowed.slice(0, 5)) {
      lines.push(`- ${s.title} (${s.projectName}) — ${s.factor}× its median`);
    }
  }

  if (history && history.mostFailing.length > 0) {
    lines.push('');
    lines.push('## Most failing (recent runs)');
    for (const m of history.mostFailing.slice(0, 5)) {
      lines.push(`- ${m.title} (${m.projectName}) — ${m.failures}/${m.runs} runs`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Minimal renderer for the Markdown THIS tool generates (email-ready HTML). */
export function summaryToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inTable = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const line of lines) {
    if (line.startsWith('|')) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!inTable) {
        out.push('<table>');
        inTable = true;
      }
      out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    if (inTable) {
      out.push('</table>');
      inTable = false;
    }
    if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith('# ')) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (/^\s*- /.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*- /, ''))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  if (inTable) out.push('</table>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Beacon summary</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#101828}
table{border-collapse:collapse}td{border:1px solid #e5e9ef;padding:6px 12px}
code{background:#f1f3f6;padding:1px 5px;border-radius:4px;font-size:13px}
h1{font-size:22px}h2{font-size:16px;margin-top:24px}li{margin:4px 0}</style>
</head><body>
${out.join('\n')}
</body></html>
`;
}
