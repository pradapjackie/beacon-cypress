import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Interop exports: JUnit XML, CTRF JSON, and CSV from a generated report. */

export type ConvertFormat = 'junit' | 'ctrf' | 'csv';

interface Detail {
  caseId: string;
  title: string;
  titlePath: string[];
  projectName: string;
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  category?: string;
  tags: string[];
  location: { file: string; line: number };
  results: Array<{
    status: string;
    duration: number;
    errors: Array<{ message: string; stack?: string }>;
  }>;
}

function parseChunk<T>(source: string): T {
  return JSON.parse(source.slice(source.indexOf(', ') + 2, source.lastIndexOf(');'))) as T;
}

async function load(reportDir: string) {
  const dataDir = path.join(reportDir, 'data');
  const manifest = parseChunk<{
    meta: { startTime: number; duration: number };
    counts: { total: number; expected: number; unexpected: number; flaky: number; skipped: number };
  }>(await readFile(path.join(dataDir, 'manifest.js'), 'utf8'));
  const details: Detail[] = [];
  for (const name of (await readdir(path.join(dataDir, 'details'))).filter((f) =>
    f.endsWith('.js'),
  )) {
    details.push(
      ...parseChunk<Detail[]>(await readFile(path.join(dataDir, 'details', name), 'utf8')),
    );
  }
  return { manifest, details };
}

const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function toJUnit(details: Detail[]): string {
  const byFile = new Map<string, Detail[]>();
  for (const d of details) {
    const group = byFile.get(d.location.file) ?? [];
    group.push(d);
    byFile.set(d.location.file, group);
  }
  const suites = [...byFile.entries()].map(([file, tests]) => {
    const cases = tests
      .map((t) => {
        const duration = (t.results.reduce((s, r) => s + r.duration, 0) / 1000).toFixed(3);
        const name = xml(`${t.title} (${t.projectName})`);
        const open = `    <testcase name="${name}" classname="${xml(file)}" time="${duration}">`;
        if (t.outcome === 'skipped') return `${open}\n      <skipped/>\n    </testcase>`;
        if (t.outcome === 'unexpected') {
          const error = t.results.flatMap((r) => r.errors)[0];
          return `${open}\n      <failure message="${xml(error?.message.split('\n')[0] ?? 'failed')}">${xml(error?.stack ?? error?.message ?? '')}</failure>\n    </testcase>`;
        }
        return `${open}</testcase>`;
      })
      .join('\n');
    const failures = tests.filter((t) => t.outcome === 'unexpected').length;
    const skipped = tests.filter((t) => t.outcome === 'skipped').length;
    return `  <testsuite name="${xml(file)}" tests="${tests.length}" failures="${failures}" skipped="${skipped}">\n${cases}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

function toCtrf(details: Detail[], meta: { startTime: number; duration: number }): string {
  const statusOf = (o: Detail['outcome']) =>
    o === 'expected' || o === 'flaky' ? 'passed' : o === 'unexpected' ? 'failed' : 'skipped';
  return `${JSON.stringify(
    {
      results: {
        tool: { name: 'beacon-reporter' },
        summary: {
          tests: details.length,
          passed: details.filter((d) => d.outcome === 'expected' || d.outcome === 'flaky').length,
          failed: details.filter((d) => d.outcome === 'unexpected').length,
          skipped: details.filter((d) => d.outcome === 'skipped').length,
          pending: 0,
          other: 0,
          start: meta.startTime,
          stop: meta.startTime + meta.duration,
        },
        tests: details.map((d) => ({
          name: `${d.title} (${d.projectName})`,
          status: statusOf(d.outcome),
          duration: d.results.reduce((s, r) => s + r.duration, 0),
          flaky: d.outcome === 'flaky' || undefined,
          retries: Math.max(0, d.results.length - 1) || undefined,
          filePath: d.location.file,
          tags: d.tags.length > 0 ? d.tags : undefined,
          message:
            d.outcome === 'unexpected'
              ? d.results.flatMap((r) => r.errors)[0]?.message.split('\n')[0]
              : undefined,
        })),
      },
    },
    null,
    2,
  )}\n`;
}

function toCsv(details: Detail[]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = details.map((d) =>
    [
      d.caseId,
      d.title,
      d.projectName,
      d.location.file,
      d.location.line,
      d.outcome,
      d.results[d.results.length - 1]?.status ?? '',
      d.results.reduce((s, r) => s + r.duration, 0),
      Math.max(0, d.results.length - 1),
      d.tags.join(' '),
      d.category ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return `caseId,title,project,file,line,outcome,status,durationMs,retries,tags,category\n${rows.join('\n')}\n`;
}

export async function convert(
  reportDir: string,
  format: ConvertFormat,
  outFile: string,
): Promise<{ tests: number }> {
  const { manifest, details } = await load(reportDir);
  const body =
    format === 'junit'
      ? toJUnit(details)
      : format === 'ctrf'
        ? toCtrf(details, manifest.meta)
        : toCsv(details);
  await writeFile(outFile, body, 'utf8');
  return { tests: details.length };
}
