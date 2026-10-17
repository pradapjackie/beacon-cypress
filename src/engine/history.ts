import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type CompareData,
  type HistoryData,
  type HistoryRun,
  SCHEMA_VERSION,
  TEST_OUTCOMES,
  type TestDetail,
  historyRunSchema,
} from './schema';

/**
 * Serverless history (ROADMAP.md §History): a directory of compact per-run
 * JSON files the reporter reads at onEnd and appends to afterwards. Trends and
 * run-over-run deltas are computed here, at generate time, and embedded into
 * the report (data/history.js) — so every report is self-contained and the
 * directory is only the reporter's persistence. CI keeps it via cache/pages.
 */

export interface HistoryOptions {
  dir: string;
  retain: number;
  ci?: { branch?: string; sha?: string; runUrl?: string };
}

export interface HistoryResult {
  data: HistoryData;
  /** Per-test outcome/duration across the window (outcome -1 = absent). */
  perCase: Map<string, { outcomes: number[]; durations: number[] }>;
  /** Current run diffed against each retained baseline (data/compare.js). */
  compare: CompareData;
}

const UNEXPECTED = TEST_OUTCOMES.indexOf('unexpected');

async function loadRuns(dir: string): Promise<HistoryRun[]> {
  let names: string[] = [];
  try {
    names = (await readdir(path.join(dir, 'runs'))).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const runs: HistoryRun[] = [];
  for (const name of names) {
    try {
      const parsed = historyRunSchema.safeParse(
        JSON.parse(await readFile(path.join(dir, 'runs', name), 'utf8')),
      );
      if (parsed.success) runs.push(parsed.data);
    } catch {
      // A corrupt run file never breaks report generation.
    }
  }
  return runs.sort((a, b) => a.startTime - b.startTime);
}

export async function updateHistory(
  details: TestDetail[],
  current: { startTime: number; duration: number; counts: HistoryRun['counts']; coverage?: number },
  options: HistoryOptions,
): Promise<HistoryResult> {
  const prior = await loadRuns(options.dir);
  const kept = prior.slice(-Math.max(0, options.retain - 1));

  const currentRun: HistoryRun = {
    schemaVersion: SCHEMA_VERSION,
    runId: `${current.startTime.toString(36)}-${randomBytes(4).toString('hex')}`,
    startTime: current.startTime,
    duration: current.duration,
    branch: options.ci?.branch,
    sha: options.ci?.sha,
    runUrl: options.ci?.runUrl,
    counts: current.counts,
    cases: Object.fromEntries(
      details.map((d) => [
        d.caseId,
        [
          Math.max(0, TEST_OUTCOMES.indexOf(d.outcome)),
          d.results.reduce((sum, r) => sum + r.duration, 0),
          Math.max(0, d.results.length - 1),
        ] as [number, number, number],
      ]),
    ),
    metrics: meanMetrics(details),
    coverage: current.coverage,
  };

  // Run-over-run transitions vs the latest prior run.
  const previous = kept[kept.length - 1];
  const added: string[] = [];
  const fixed: string[] = [];
  const regressed: string[] = [];
  if (previous) {
    for (const detail of details) {
      const before = previous.cases[detail.caseId];
      if (!before) {
        added.push(detail.caseId);
        continue;
      }
      const wasFailing = before[0] === UNEXPECTED;
      const isFailing = detail.outcome === 'unexpected';
      if (wasFailing && !isFailing && detail.outcome !== 'skipped') fixed.push(detail.caseId);
      else if (!wasFailing && isFailing) regressed.push(detail.caseId);
    }
  }

  // Most-failing across retained runs (current included), current tests only.
  const window = [...kept, currentRun];
  const mostFailing = details
    .map((detail) => {
      let failures = 0;
      let appearances = 0;
      for (const run of window) {
        const entry = run.cases[detail.caseId];
        if (!entry) continue;
        appearances += 1;
        if (entry[0] === UNEXPECTED) failures += 1;
      }
      return {
        caseId: detail.caseId,
        title: detail.title,
        projectName: detail.projectName,
        failures,
        runs: appearances,
      };
    })
    .filter((e) => e.failures > 0)
    .sort((a, b) => b.failures / b.runs - a.failures / a.runs || b.failures - a.failures)
    .slice(0, 10);

  // Metric means per run → sparkline series (null where a run lacks a metric).
  const metricNames = [...new Set(window.flatMap((run) => Object.keys(run.metrics ?? {})))].sort();
  const metricTrends = metricNames.map((name) => ({
    name,
    values: window.map((run) => run.metrics?.[name] ?? null),
  }));

  const data: HistoryData = {
    runs: window.map((run) => ({
      runId: run.runId,
      startTime: run.startTime,
      duration: run.duration,
      counts: run.counts,
      retries: Object.values(run.cases).reduce((sum, c) => sum + c[2], 0),
      coverage: run.coverage,
    })),
    transitions: { added, fixed, regressed },
    mostFailing,
    ...(metricTrends.length > 0 ? { metricTrends } : {}),
  };

  const perCase = new Map(
    details.map((detail) => [
      detail.caseId,
      {
        outcomes: window.map((run) => run.cases[detail.caseId]?.[0] ?? -1),
        durations: window.map((run) => run.cases[detail.caseId]?.[1] ?? 0),
      },
    ]),
  );

  const compare: CompareData = { baselines: kept.map((run) => diffRuns(run, currentRun)) };

  // Persist the current run atomically and prune beyond the retention window.
  const runsDir = path.join(options.dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const finalName = `${new Date(current.startTime).toISOString().replace(/[:.]/g, '-')}_${currentRun.runId}.json`;
  const tmp = path.join(runsDir, `.tmp-${currentRun.runId}`);
  await writeFile(tmp, `${JSON.stringify(currentRun)}\n`, 'utf8');
  await rename(tmp, path.join(runsDir, finalName));

  const all = await readdir(runsDir);
  const surplus = all
    .filter((n) => n.endsWith('.json'))
    .sort()
    .slice(0, Math.max(0, all.filter((n) => n.endsWith('.json')).length - options.retain));
  await Promise.all(surplus.map((n) => rm(path.join(runsDir, n), { force: true })));

  return { data, perCase, compare };
}

/** Mean of each beacon:metrics value across the run's tests. */
function meanMetrics(details: TestDetail[]): Record<string, number> | undefined {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const detail of details) {
    for (const [name, value] of Object.entries(detail.metrics ?? {})) {
      const s = sums.get(name) ?? { sum: 0, count: 0 };
      s.sum += value;
      s.count += 1;
      sums.set(name, s);
    }
  }
  if (sums.size === 0) return undefined;
  return Object.fromEntries(
    [...sums.entries()].map(([name, s]) => [name, Math.round((s.sum / s.count) * 100) / 100]),
  );
}

const DELTA_CAP = 50;

/** One baseline entry for data/compare.js: `current` vs an older run. */
function diffRuns(baseline: HistoryRun, current: HistoryRun): CompareData['baselines'][number] {
  const regressed: string[] = [];
  const fixed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const slower: Array<{ caseId: string; from: number; to: number }> = [];
  const faster: Array<{ caseId: string; from: number; to: number }> = [];

  for (const [caseId, now] of Object.entries(current.cases)) {
    const before = baseline.cases[caseId];
    if (!before) {
      added.push(caseId);
      continue;
    }
    const wasFailing = before[0] === UNEXPECTED;
    const isFailing = now[0] === UNEXPECTED;
    if (!wasFailing && isFailing) regressed.push(caseId);
    else if (wasFailing && !isFailing && now[0] !== TEST_OUTCOMES.indexOf('skipped')) {
      fixed.push(caseId);
    }
    const [, fromMs] = before;
    const [, toMs] = now;
    if (fromMs > 0 && toMs > 0) {
      if (toMs >= fromMs * 1.25 && toMs - fromMs >= 50) {
        slower.push({ caseId, from: fromMs, to: toMs });
      } else if (toMs <= fromMs * 0.8 && fromMs - toMs >= 50) {
        faster.push({ caseId, from: fromMs, to: toMs });
      }
    }
  }
  for (const caseId of Object.keys(baseline.cases)) {
    if (!current.cases[caseId]) removed.push(caseId);
  }
  slower.sort((a, b) => b.to - b.from - (a.to - a.from));
  faster.sort((a, b) => b.from - b.to - (a.from - a.to));

  return {
    runId: baseline.runId,
    startTime: baseline.startTime,
    counts: baseline.counts,
    regressed,
    fixed,
    added,
    removed,
    slower: slower.slice(0, DELTA_CAP),
    faster: faster.slice(0, DELTA_CAP),
  };
}
