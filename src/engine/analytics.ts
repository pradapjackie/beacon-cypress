import { type Manifest, TEST_OUTCOMES, type TestDetail } from './schema';

/**
 * Generate-time analytics beyond simple rollups: duration regressions against
 * each test's own history, and incident grouping — many tests failing with
 * the same (normalized) error usually means one root cause.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Normalizes an error message so equivalent failures cluster together. */
export function normalizeErrorMessage(message: string): string {
  const first = (message.split('\n')[0] ?? message).replace(ANSI, '');
  return first
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d+(\.\d+)?(ms|s|px)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function computeIncidents(
  details: TestDetail[],
): NonNullable<Manifest['aggregates']['incidents']> {
  const groups = new Map<string, { message: string; tests: TestDetail[] }>();
  for (const detail of details) {
    if (detail.outcome !== 'unexpected') continue;
    const raw = detail.results.flatMap((r) => r.errors)[0]?.message;
    if (!raw) continue;
    const key = normalizeErrorMessage(raw);
    if (!key) continue;
    const group = groups.get(key) ?? { message: key, tests: [] };
    group.tests.push(detail);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.tests.length >= 2)
    .sort((a, b) => b.tests.length - a.tests.length)
    .slice(0, 8)
    .map((g) => ({
      message: g.message,
      tests: g.tests.slice(0, 20).map((t) => ({
        caseId: t.caseId,
        title: t.title,
        projectName: t.projectName,
      })),
    }));
}

const SLOWDOWN_FACTOR = 1.5;
const SLOWDOWN_MIN_MEDIAN = 50;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Tests whose current duration is >= 1.5× their median across prior runs
 * (needs 2+ prior appearances; sub-50ms medians are noise, skipped).
 */
export function computeSlowedDown(
  details: TestDetail[],
  perCase: Map<string, { outcomes: number[]; durations: number[] }>,
): NonNullable<Manifest['aggregates']['slowedDown']> {
  const out: NonNullable<Manifest['aggregates']['slowedDown']> = [];
  for (const detail of details) {
    if (detail.outcome === 'skipped') continue;
    const strip = perCase.get(detail.caseId);
    if (!strip) continue;
    const prior = strip.durations
      .slice(0, -1)
      .filter((d, i) => (strip.outcomes[i] ?? -1) >= 0 && d > 0);
    if (prior.length < 2) continue;
    const base = median(prior);
    const current = strip.durations[strip.durations.length - 1] ?? 0;
    if (base < SLOWDOWN_MIN_MEDIAN || current < base * SLOWDOWN_FACTOR) continue;
    out.push({
      caseId: detail.caseId,
      title: detail.title,
      projectName: detail.projectName,
      current,
      median: base,
      factor: Math.round((current / base) * 10) / 10,
    });
  }
  return out.sort((a, b) => b.factor - a.factor).slice(0, 10);
}

/** Consecutive unexpected runs ending now (0 or 1 = not a streak). */
export function failingStreakOf(outcomes: number[], unexpectedIndex: number): number {
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] === unexpectedIndex) streak += 1;
    else if (outcomes[i] === -1) continue;
    else break;
  }
  return streak;
}

/** "2s" | "1500ms" | "1500" → ms; undefined when unparseable. */
export function parseBudget(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] ?? 'ms';
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n;
}

export function computeWaste(details: TestDetail[]): NonNullable<Manifest['aggregates']['waste']> {
  let retryMs = 0;
  let failedMs = 0;
  let retriedTests = 0;
  let rescued = 0;
  let attempts = 0;
  for (const detail of details) {
    if (detail.results.length > 1) {
      retriedTests += 1;
      attempts += detail.results.length - 1;
      for (const result of detail.results.slice(0, -1)) retryMs += result.duration;
    }
    if (detail.outcome === 'flaky') rescued += 1;
    if (detail.outcome === 'unexpected') {
      failedMs += detail.results.reduce((s, r) => s + r.duration, 0);
    }
  }
  return { retryMs, failedMs, retriedTests, rescued, attempts };
}

export function computeHealth(counts: {
  total: number;
  expected: number;
  unexpected: number;
  flaky: number;
}): NonNullable<Manifest['aggregates']['health']> {
  const total = Math.max(1, counts.total);
  const passRate = (counts.expected + counts.flaky) / total;
  const flakyShare = counts.flaky / total;
  const failShare = counts.unexpected / total;
  // Pass rate already prices in hard failures; flaky and failing shares take
  // an extra half-weight penalty so instability drags the score below 100.
  const score = Math.max(
    0,
    Math.min(100, Math.round(passRate * 100 - flakyShare * 50 - failShare * 50)),
  );
  return { score, passRate, flakyShare, failShare };
}

const EXPECTED_IDX = TEST_OUTCOMES.indexOf('expected');
const UNEXPECTED_IDX = TEST_OUTCOMES.indexOf('unexpected');
const FLAKY_IDX = TEST_OUTCOMES.indexOf('flaky');
const EWMA_ALPHA = 0.35;

/**
 * Recency-weighted flakiness per test: a run scores 1 when the outcome was
 * flaky (failed then passed on retry), 0.7 when it flipped pass↔fail against
 * the previous run it appeared in, else 0; the EWMA of those signals ×100 is
 * the score. Only tests that ever flaked or flipped are returned, worst first.
 */
export function computeFlakiness(
  details: TestDetail[],
  perCase: Map<string, { outcomes: number[]; durations: number[] }>,
): NonNullable<Manifest['aggregates']['flakiness']> {
  const out: NonNullable<Manifest['aggregates']['flakiness']> = [];
  for (const detail of details) {
    const strip = perCase.get(detail.caseId);
    if (!strip) continue;
    let ewma = 0;
    let flakyRuns = 0;
    let failedRuns = 0;
    let runs = 0;
    let previous = -1;
    for (const outcome of strip.outcomes) {
      if (outcome < 0) continue; // absent from that run
      runs += 1;
      if (outcome === FLAKY_IDX) flakyRuns += 1;
      if (outcome === UNEXPECTED_IDX) failedRuns += 1;
      const flipped =
        previous >= 0 &&
        ((previous === EXPECTED_IDX && outcome === UNEXPECTED_IDX) ||
          (previous === UNEXPECTED_IDX && outcome === EXPECTED_IDX));
      const signal = outcome === FLAKY_IDX ? 1 : flipped ? 0.7 : 0;
      ewma = EWMA_ALPHA * signal + (1 - EWMA_ALPHA) * ewma;
      previous = outcome;
    }
    const score = Math.round(ewma * 100);
    if (score > 0 && (flakyRuns > 0 || failedRuns > 0)) {
      out.push({
        caseId: detail.caseId,
        title: detail.title,
        projectName: detail.projectName,
        score,
        flakyRuns,
        failedRuns,
        runs,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.flakyRuns - a.flakyRuns).slice(0, 100);
}

/**
 * `page.goto(https://…)` and `Expect "toBe"` aggregate under one key when only
 * their arguments differ: the argument list and quoted strings are stripped.
 */
export function normalizeStepTitle(title: string): string {
  return title
    .replace(/\(.*\)\s*$/s, '')
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .trim()
    .slice(0, 120);
}

interface StepLike {
  title: string;
  category: string;
  duration: number;
  steps: StepLike[];
}

/**
 * Leaf pw:api/expect steps across all attempts, grouped by normalized title —
 * "where does the runtime actually go". Parents are skipped so child time is
 * never double-counted.
 */
export function computeSlowestSteps(
  details: TestDetail[],
): NonNullable<Manifest['aggregates']['slowestSteps']> {
  const groups = new Map<
    string,
    { title: string; category: string; count: number; totalMs: number; maxMs: number }
  >();
  const visit = (step: StepLike) => {
    if (step.steps.length > 0) {
      for (const child of step.steps) visit(child);
      return;
    }
    if (step.category !== 'pw:api' && step.category !== 'expect') return;
    const title = normalizeStepTitle(step.title);
    if (!title) return;
    const key = `${step.category}\u0000${title}`;
    const group = groups.get(key) ?? {
      title,
      category: step.category,
      count: 0,
      totalMs: 0,
      maxMs: 0,
    };
    group.count += 1;
    group.totalMs += step.duration;
    group.maxMs = Math.max(group.maxMs, step.duration);
    groups.set(key, group);
  };
  for (const detail of details) {
    for (const result of detail.results) {
      for (const step of result.steps) visit(step);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 15)
    .map((g) => ({ ...g, avgMs: Math.round((g.totalMs / g.count) * 10) / 10 }));
}
