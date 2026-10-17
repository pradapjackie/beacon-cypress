import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * `beacon history show|prune` — inspect and trim the .beacon-history
 * directory the reporter appends to. Read-side mirror of reporter/history.ts:
 * one compact JSON file per run under <dir>/runs/.
 */

interface RunFile {
  file: string;
  runId: string;
  startTime: number;
  duration: number;
  branch?: string;
  counts: { total: number; expected: number; unexpected: number; flaky: number; skipped: number };
}

export async function listRuns(dir: string): Promise<RunFile[]> {
  const runsDir = path.join(dir, 'runs');
  let names: string[] = [];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith('.json'));
  } catch {
    throw new Error(`No history at ${runsDir} — run tests with history enabled first.`);
  }
  const runs: RunFile[] = [];
  for (const name of names.sort()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as Omit<
        RunFile,
        'file'
      >;
      runs.push({ file: name, ...parsed });
    } catch {
      // Corrupt file: surface it in `show` output rather than crashing.
      runs.push({
        file: name,
        runId: '(corrupt)',
        startTime: 0,
        duration: 0,
        counts: { total: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
      });
    }
  }
  return runs;
}

export function renderRuns(runs: RunFile[]): string {
  const lines = ['date                 total  failed  flaky  skipped  duration  branch'];
  for (const run of runs) {
    const date = run.startTime ? new Date(run.startTime).toISOString().slice(0, 16) : '(corrupt)';
    lines.push(
      `${date.padEnd(20)} ${String(run.counts.total).padStart(5)}  ${String(run.counts.unexpected).padStart(6)}  ${String(run.counts.flaky).padStart(5)}  ${String(run.counts.skipped).padStart(7)}  ${`${Math.round(run.duration / 1000)}s`.padStart(8)}  ${run.branch ?? ''}`,
    );
  }
  lines.push(`\n${runs.length} runs retained.`);
  return lines.join('\n');
}

export async function pruneRuns(dir: string, retain: number): Promise<number> {
  const runs = await listRuns(dir);
  const surplus = runs.slice(0, Math.max(0, runs.length - retain));
  await Promise.all(surplus.map((run) => rm(path.join(dir, 'runs', run.file), { force: true })));
  return surplus.length;
}
