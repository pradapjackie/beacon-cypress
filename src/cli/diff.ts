import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * `beacon diff <a> <b>`: textual comparison of two reports — new, removed,
 * fixed, regressed and slowed tests. The CLI precursor to a compare UI.
 */

interface Entry {
  title: string;
  projectName: string;
  outcome: string;
  duration: number;
}

function parseChunk<T>(source: string): T {
  return JSON.parse(source.slice(source.indexOf(', ') + 2, source.lastIndexOf(');'))) as T;
}

async function loadReport(dir: string): Promise<Map<string, Entry>> {
  const detailsDir = path.join(dir, 'data', 'details');
  const byId = new Map<string, Entry>();
  for (const name of (await readdir(detailsDir)).filter((f) => f.endsWith('.js'))) {
    const details = parseChunk<
      Array<{
        caseId: string;
        title: string;
        projectName: string;
        outcome: string;
        results: Array<{ duration: number }>;
      }>
    >(await readFile(path.join(detailsDir, name), 'utf8'));
    for (const d of details) {
      byId.set(d.caseId, {
        title: d.title,
        projectName: d.projectName,
        outcome: d.outcome,
        duration: d.results.reduce((s, r) => s + r.duration, 0),
      });
    }
  }
  return byId;
}

export interface DiffResult {
  added: Entry[];
  removed: Entry[];
  fixed: Entry[];
  regressed: Entry[];
  slower: Array<Entry & { before: number; factor: number }>;
}

export async function diffReports(dirA: string, dirB: string): Promise<DiffResult> {
  const [a, b] = await Promise.all([loadReport(dirA), loadReport(dirB)]);
  const result: DiffResult = { added: [], removed: [], fixed: [], regressed: [], slower: [] };

  for (const [caseId, entry] of b) {
    const before = a.get(caseId);
    if (!before) {
      result.added.push(entry);
      continue;
    }
    const wasFailing = before.outcome === 'unexpected';
    const isFailing = entry.outcome === 'unexpected';
    if (wasFailing && !isFailing && entry.outcome !== 'skipped') result.fixed.push(entry);
    else if (!wasFailing && isFailing) result.regressed.push(entry);
    if (before.duration > 50 && entry.duration >= before.duration * 1.5) {
      result.slower.push({
        ...entry,
        before: before.duration,
        factor: Math.round((entry.duration / before.duration) * 10) / 10,
      });
    }
  }
  for (const [caseId, entry] of a) {
    if (!b.has(caseId)) result.removed.push(entry);
  }
  result.slower.sort((x, y) => y.factor - x.factor);
  return result;
}

export function printDiff(diff: DiffResult): string {
  const lines: string[] = [];
  const section = (label: string, entries: Entry[], render?: (e: Entry) => string) => {
    lines.push(`${label}: ${entries.length}`);
    for (const e of entries.slice(0, 20)) {
      lines.push(`  - ${render ? render(e) : `${e.title} (${e.projectName})`}`);
    }
  };
  section('Regressed', diff.regressed);
  section('Fixed', diff.fixed);
  section('New', diff.added);
  section('Removed', diff.removed);
  lines.push(`Slower (>=1.5x): ${diff.slower.length}`);
  for (const e of diff.slower.slice(0, 20)) {
    lines.push(
      `  - ${e.title} (${e.projectName}) — ${e.before}ms → ${e.duration}ms (${e.factor}×)`,
    );
  }
  return lines.join('\n');
}
