import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTACHMENT_BITS,
  DASHBOARD_CARDS,
  DEFAULT_DASHBOARD_CARDS,
  type ErrorInfo,
  type GroupRollup,
  type Manifest,
  type RunCounts,
  type RunStatus,
  SCHEMA_VERSION,
  TEST_OUTCOMES,
  TEST_STATUSES,
  type TestDetail,
  type TestIndexChunk,
  compareDataSchema,
  errorIndexSchema,
  historyDataSchema,
  manifestSchema,
  testDetailSchema,
  testIndexChunkSchema,
  timelineDataSchema,
} from './schema';
import {
  computeFlakiness,
  computeHealth,
  computeIncidents,
  computeSlowedDown,
  computeSlowestSteps,
  computeWaste,
  failingStreakOf,
} from './analytics';
import { type CategoryRule, categorize } from './categories';
import { readCoverageSummary } from './coverage';
import { updateHistory } from './history';
import { jsonForScript } from './script-json';

/** The few config fields the report pages read. Cypress fills these; Playwright does too. */
export interface BeaconRunConfig {
  rootDir?: string;
  workers?: number;
  fullyParallel?: boolean;
  forbidOnly?: boolean;
  globalTimeout?: number;
  maxFailures?: number;
  quiet?: boolean;
  grep?: unknown;
  grepInvert?: unknown;
  updateSnapshots?: string;
  reporter?: unknown;
  shard?: { current: number; total: number } | null;
  projects?: Array<{
    name: string;
    testDir?: string;
    timeout?: number;
    retries?: number;
    grep?: unknown;
  }>;
  version?: string;
}

const INDEX_CHUNK_SIZE = 5000;
const DETAILS_CHUNK_SIZE = 50;

export interface DashboardOptions {
  /** Cards to show, in order. Unknown ids are warned about and dropped. */
  cards?: string[];
  /** How many slowest tests to include (default 5). */
  slowest?: number;
}

export interface WriteReportInput {
  outputDir: string;
  status: RunStatus;
  startTime: number;
  duration: number;
  details: TestDetail[];
  errors: ErrorInfo[];
  config: BeaconRunConfig;
  /** Package version written into the manifest. */
  beaconVersion?: string;
  copyUi: boolean;
  title?: string;
  dashboard?: DashboardOptions;
  environment?: Record<string, string>;
  links?: Record<string, string>;
  categories?: CategoryRule[];
  /** Unscrubbed error text per case, so category rules see the original message. */
  categoryText?: Map<string, string>;
  history?: { dir: string; retain: number };
  editorLinks?: boolean;
  /** White-labeling: logo (absolute path, ≤64KB image) + accent hex color. */
  branding?: { logo?: string; accentColor?: string };
  /** Attachment-store dedupe accounting, from AttachmentStore.stats. */
  storage?: { count: number; unique: number; bytes: number; dedupedBytes: number };
  /** Watch mode: this is an interim write; the run is still going. */
  inProgress?: boolean;
  /** Plugin-contributed dashboard cards. */
  customCards?: NonNullable<Manifest['ui']>['customCards'];
  /** Absolute path to an istanbul coverage-summary.json to ingest. */
  coveragePath?: string;
}

/**
 * Emits the report: chunked `.js` data files (script tags work on file://,
 * localhost, and static hosting alike, where fetch() of local JSON does not)
 * plus a copy of the prebuilt SPA. All aggregation happens here, at generate
 * time — the browser only renders.
 */
export async function writeReport(input: WriteReportInput): Promise<void> {
  // Group tests by spec file so "click through a spec" hits one details
  // chunk; the index lists tests in the same packed order.
  const byFile = new Map<string, TestDetail[]>();
  for (const detail of input.details) {
    const group = byFile.get(detail.location.file) ?? [];
    group.push(detail);
    byFile.set(detail.location.file, group);
  }

  const files = [...byFile.keys()].sort();
  const detailsChunks: TestDetail[][] = [];
  const chunkOfCase = new Map<string, number>();
  let current: TestDetail[] = [];
  for (const file of files) {
    const group = byFile.get(file) ?? [];
    if (current.length > 0 && current.length + group.length > DETAILS_CHUNK_SIZE) {
      detailsChunks.push(current);
      current = [];
    }
    for (const detail of group) {
      chunkOfCase.set(detail.caseId, detailsChunks.length);
      current.push(detail);
    }
  }
  if (current.length > 0) detailsChunks.push(current);

  const ordered = detailsChunks.flat();
  // Mutates failing details with a `category` before chunks serialize.
  categorize(ordered, input.categories, input.categoryText);
  // Shard provenance: only a single-shard run knows which shard it is —
  // merged blob reports carry no per-test shard in the Reporter API.
  if (input.config.shard) {
    for (const detail of ordered) detail.shard = input.config.shard.current;
  }
  const projects = [...new Set(ordered.map((d) => d.projectName))].sort();
  const tags = [...new Set(ordered.flatMap((d) => d.tags))].sort();
  const suites = [...new Set(ordered.map(suiteOf))].sort();

  const counts: RunCounts = { total: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const detail of ordered) {
    counts.total += 1;
    counts[detail.outcome] += 1;
  }

  const indexChunks: TestIndexChunk[] = [];
  for (let start = 0; start < ordered.length; start += INDEX_CHUNK_SIZE) {
    indexChunks.push(
      buildIndexChunk(ordered.slice(start, start + INDEX_CHUNK_SIZE), {
        projects,
        files,
        tags,
        suites,
        chunkOfCase,
      }),
    );
  }

  const slowest = ordered
    .map((d) => ({
      caseId: d.caseId,
      title: d.title,
      projectName: d.projectName,
      duration: d.results.reduce((sum, r) => sum + r.duration, 0),
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, Math.max(1, input.dashboard?.slowest ?? 5));

  // Rollups per grouping dimension: tags (a.k.a. markers), spec files, categories.
  const tagRollups = rollupBy(ordered, (d) => d.tags);
  const fileRollups = rollupBy(ordered, (d) => [d.location.file]).slice(0, 20);
  const suiteRollups = rollupBy(ordered, (d) => {
    const suite = suiteOf(d);
    return suite ? [suite] : [];
  }).slice(0, 20);
  const categoryRollups = rollupBy(ordered, (d) => (d.category ? [d.category] : []));
  const severityRollups = rollupBy(ordered, (d) => {
    const severity = d.annotations.find((a) => a.type === 'severity')?.description;
    return severity ? [severity.toLowerCase()] : [];
  });
  const requirementsOf = (d: TestDetail) =>
    d.annotations
      .filter((a) => a.type === 'requirement' && a.description)
      .map((a) => a.description as string);
  const requirementRollups = rollupBy(ordered, requirementsOf);
  const REQUIREMENTS_CAP = 100;
  const requirementsMatrix = requirementRollups.slice(0, REQUIREMENTS_CAP).map((rollup) => ({
    id: rollup.name,
    tests: ordered
      .filter((d) => requirementsOf(d).includes(rollup.name))
      .map((d) => ({
        caseId: d.caseId,
        title: d.title,
        projectName: d.projectName,
        outcome: Math.max(0, TEST_OUTCOMES.indexOf(d.outcome)),
      })),
  }));
  const coverage = input.coveragePath ? await readCoverageSummary(input.coveragePath) : undefined;

  // Duration histogram (log-scale-ish fixed buckets) + parallel speedup.
  const BUCKETS = [
    { label: '<100ms', max: 100 },
    { label: '100–300ms', max: 300 },
    { label: '300ms–1s', max: 1000 },
    { label: '1–3s', max: 3000 },
    { label: '3–10s', max: 10_000 },
    { label: '10–30s', max: 30_000 },
    { label: '>30s', max: Number.POSITIVE_INFINITY },
  ];
  const durations = BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  let serialized = 0;
  for (const detail of ordered) {
    const total = detail.results.reduce((sum, r) => sum + r.duration, 0);
    serialized += total;
    const bucket = BUCKETS.findIndex((b) => total < b.max);
    const slot = durations[bucket >= 0 ? bucket : durations.length - 1];
    if (slot) slot.count += 1;
  }
  const speedup = {
    serialized,
    wall: input.duration,
    factor: input.duration > 0 ? Math.round((serialized / input.duration) * 10) / 10 : 1,
  };

  const knownCards = new Set<string>(DASHBOARD_CARDS);
  const requestedCards = input.dashboard?.cards ?? DEFAULT_DASHBOARD_CARDS;
  const unknownCards = requestedCards.filter((c) => !knownCards.has(c));
  if (unknownCards.length > 0) {
    console.warn(
      `[beacon] Unknown dashboard card(s) ignored: ${unknownCards.join(', ')} — valid: ${DASHBOARD_CARDS.join(', ')}`,
    );
  }
  const cards = requestedCards.filter((c) => knownCards.has(c));

  const projectRollups = projects.map((name) => {
    const rollup = { name, total: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const detail of ordered) {
      if (detail.projectName !== name) continue;
      rollup.total += 1;
      rollup[detail.outcome] += 1;
    }
    return rollup;
  });

  // Worker timeline lanes: one entry per attempt, relative to the earliest
  // start. Lanes live in their own chunk (data/timeline.js) so the manifest
  // stays small — only the /timeline page loads them. Capped at huge runs.
  const TIMELINE_CAP = 5000;
  let timeline = ordered.flatMap((detail) =>
    detail.results
      .filter((r) => r.duration > 0)
      .flatMap((r) => {
        // workerIndex climbs every time Playwright restarts a worker process.
        // parallelIndex is the pool slot and stays stable for the run.
        const lane = r.parallelIndex >= 0 ? r.parallelIndex : r.workerIndex;
        if (lane < 0) return [];
        return [
          {
            caseId: detail.caseId,
            title: detail.title,
            projectName: detail.projectName,
            workerIndex: lane,
            start: r.startTime,
            duration: r.duration,
            outcome: Math.max(0, TEST_OUTCOMES.indexOf(detail.outcome)),
            retry: r.retry,
          },
        ];
      }),
  );
  const minStart = timeline.reduce((min, e) => Math.min(min, e.start), Number.POSITIVE_INFINITY);
  timeline = timeline
    .map((e) => ({ ...e, start: e.start - minStart }))
    .sort((a, b) => a.start - b.start);
  const timelineTruncated = timeline.length > TIMELINE_CAP;
  if (timelineTruncated) timeline = timeline.slice(0, TIMELINE_CAP);
  const timelineData = { entries: timeline, ...(timelineTruncated ? { truncated: true } : {}) };
  timelineDataSchema.parse(timelineData);
  const timelineChunk = timeline.length > 0 ? toChunk('timeline', timelineData) : undefined;

  const ci = detectCi();

  // History first: analytics below (slowdowns, streaks) need per-test windows.
  let historyChunk: string | undefined;
  let compareChunk: string | undefined;
  let perCase = new Map<string, { outcomes: number[]; durations: number[] }>();
  if (input.history) {
    try {
      const result = await updateHistory(
        ordered,
        { startTime: input.startTime, duration: input.duration, counts, coverage: coverage?.lines },
        { ...input.history, ci },
      );
      historyDataSchema.parse(result.data);
      historyChunk = toChunk('history', result.data);
      if (result.compare.baselines.length > 0) {
        compareDataSchema.parse(result.compare);
        compareChunk = toChunk('compare', result.compare);
      }
      perCase = result.perCase;
      if (result.data.runs.length > 1) {
        const unexpectedIdx = TEST_OUTCOMES.indexOf('unexpected');
        for (const detail of ordered) {
          const strip = perCase.get(detail.caseId);
          if (!strip) continue;
          detail.history = strip.outcomes;
          detail.historyDurations = strip.durations;
          const streak = failingStreakOf(strip.outcomes, unexpectedIdx);
          if (streak >= 2) detail.failingStreak = streak;
        }
      }
    } catch (error) {
      console.warn(
        `[beacon] History update failed (report still generated): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const ownerRollups = rollupBy(ordered, (d) => {
    const owner = d.annotations.find((a) => a.type === 'owner')?.description;
    return owner ? [owner] : [];
  });
  const slowedDown = computeSlowedDown(ordered, perCase);
  const flakiness = computeFlakiness(ordered, perCase);
  const slowestSteps = computeSlowestSteps(ordered);
  const a11y = await aggregateA11y(ordered, input.outputDir);
  const incidents = computeIncidents(ordered);
  const percentiles = computePercentiles(ordered, projects);
  // Needs the history pass above: failingStreak marks a repeat offender.
  const failureFreshness = ordered.reduce(
    (acc, d) => {
      if (d.outcome !== 'unexpected') return acc;
      if ((d.failingStreak ?? 0) >= 2) acc.known += 1;
      else acc.fresh += 1;
      return acc;
    },
    { fresh: 0, known: 0 },
  );

  // Error-text index: "search in errors" becomes a map lookup at any size.
  const errorIndex: Record<string, string> = {};
  for (const detail of ordered) {
    const text = detail.results
      .flatMap((r) => r.errors)
      .map((e) => `${e.message}\n${e.snippet ?? ''}`)
      .join('\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .toLowerCase()
      .slice(0, 1000);
    if (text.trim()) errorIndex[detail.caseId] = text;
  }
  const errorChunk =
    Object.keys(errorIndex).length > 0
      ? toChunk('errors', errorIndexSchema.parse(errorIndex))
      : undefined;
  const waste = computeWaste(ordered);
  const health = computeHealth(counts);
  const budgets = ordered
    .filter((d) => {
      const total = d.results.reduce((s, r) => s + r.duration, 0);
      return d.budgetMs !== undefined && total > d.budgetMs;
    })
    .map((d) => ({
      caseId: d.caseId,
      title: d.title,
      projectName: d.projectName,
      duration: d.results.reduce((s, r) => s + r.duration, 0),
      budget: d.budgetMs ?? 0,
    }))
    .sort((a, b) => b.duration / b.budget - a.duration / a.budget)
    .slice(0, 10);
  const metricStats = new Map<string, { count: number; sum: number; max: number }>();
  for (const detail of ordered) {
    for (const [name, value] of Object.entries(detail.metrics ?? {})) {
      const s = metricStats.get(name) ?? { count: 0, sum: 0, max: Number.NEGATIVE_INFINITY };
      s.count += 1;
      s.sum += value;
      s.max = Math.max(s.max, value);
      metricStats.set(name, s);
    }
  }
  const metricRollups = [...metricStats.entries()].map(([name, s]) => ({
    name,
    count: s.count,
    avg: Math.round((s.sum / s.count) * 100) / 100,
    max: s.max,
  }));

  const manifest: Manifest = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      beaconVersion: input.beaconVersion ?? '0.0.0',
      playwrightVersion: detectPlaywrightVersion(input.config),
      generatedAt: Date.now(),
      startTime: input.startTime,
      duration: input.duration,
      status: input.status,
      ci,
      rootDir: input.editorLinks ? input.config.rootDir : undefined,
      config: {
        workers: input.config.workers,
        fullyParallel: input.config.fullyParallel,
        shard: input.config.shard
          ? { current: input.config.shard.current, total: input.config.shard.total }
          : undefined,
      },
      errors: input.errors,
      configSnapshot: snapshotConfig(input.config),
      ...(input.inProgress ? { inProgress: true } : {}),
    },
    counts,
    projects: projects.map((name) => ({ name })),
    files,
    tags,
    suites,
    chunks: { index: indexChunks.length, details: detailsChunks.length },
    ui: {
      title: input.title,
      cards,
      links: input.links,
      editorLinks: input.editorLinks,
      branding: await loadBranding(input.branding),
      customCards: input.customCards,
    },
    environment: {
      os: `${os.platform()} ${os.release()}`,
      node: process.version,
      ...input.environment,
    },
    aggregates: {
      slowest,
      projects: projectRollups,
      tags: tagRollups,
      files: fileRollups,
      suites: suiteRollups,
      categories: categoryRollups,
      severity: severityRollups,
      owners: ownerRollups,
      slowedDown,
      flakiness,
      slowestSteps,
      ...(a11y ? { a11y } : {}),
      percentiles,
      failureFreshness,
      ...(coverage ? { coverage } : {}),
      requirements: requirementRollups,
      ...(requirementsMatrix.length > 0 ? { requirementsMatrix } : {}),
      ...(input.storage ? { storage: input.storage } : {}),
      incidents,
      waste,
      health,
      budgets,
      metrics: metricRollups,
      durations,
      speedup,
    },
  };

  // Dogfood the contract: never write data the UI's schema would reject.
  manifestSchema.parse(manifest);
  for (const chunk of indexChunks) testIndexChunkSchema.parse(chunk);
  for (const chunk of detailsChunks) for (const detail of chunk) testDetailSchema.parse(detail);

  const dataDir = path.join(input.outputDir, 'data');
  await mkdir(path.join(dataDir, 'index'), { recursive: true });
  await mkdir(path.join(dataDir, 'details'), { recursive: true });
  const passRate =
    counts.total === 0 ? 100 : Math.round(((counts.expected + counts.flaky) / counts.total) * 100);
  // Atomic (tmp + rename) so watch mode never serves a half-written chunk.
  await Promise.all([
    writeAtomic(path.join(dataDir, 'manifest.js'), toChunk('manifest', manifest)),
    writeAtomic(path.join(input.outputDir, 'badge.svg'), badgeSvg(passRate)),
    ...(historyChunk ? [writeAtomic(path.join(dataDir, 'history.js'), historyChunk)] : []),
    ...(compareChunk ? [writeAtomic(path.join(dataDir, 'compare.js'), compareChunk)] : []),
    ...(errorChunk ? [writeAtomic(path.join(dataDir, 'errors.js'), errorChunk)] : []),
    ...(timelineChunk ? [writeAtomic(path.join(dataDir, 'timeline.js'), timelineChunk)] : []),
    ...indexChunks.map((chunk, i) =>
      writeAtomic(path.join(dataDir, 'index', `chunk-${i}.js`), toChunk(`index/chunk-${i}`, chunk)),
    ),
    ...detailsChunks.map((chunk, i) =>
      writeAtomic(
        path.join(dataDir, 'details', `chunk-${i}.js`),
        toChunk(`details/chunk-${i}`, chunk),
      ),
    ),
  ]);

  // Interim writes never clear assets/ — a browser may be loading them.
  if (input.copyUi) await copyUi(input.outputDir, { clean: !input.inProgress });
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

const A11Y_NAME = /axe|a11y|accessibility/i;
const A11Y_MAX_FILES = 200;
const A11Y_MAX_BYTES = 2 * 1024 * 1024;
const IMPACT_RANK: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/**
 * Reads back stored axe-style JSON attachments ({violations: [...]}) and
 * aggregates them by rule id — an accessibility rollup for the dashboard.
 */
async function aggregateA11y(
  details: TestDetail[],
  outputDir: string,
): Promise<Manifest['aggregates']['a11y']> {
  const groups = new Map<string, { impact: string; nodes: number; tests: Set<string> }>();
  const scanned = new Set<string>();
  let reads = 0;
  for (const detail of details) {
    for (const result of detail.results) {
      for (const ref of result.attachments) {
        if (!A11Y_NAME.test(ref.name) || !ref.contentType.includes('json')) continue;
        if (ref.mode !== 'stored' || !ref.sha256 || (ref.size ?? 0) > A11Y_MAX_BYTES) continue;
        if (reads >= A11Y_MAX_FILES) break;
        reads += 1;
        try {
          const file = path.join(outputDir, 'attachments', `${ref.sha256}.${ref.ext ?? 'json'}`);
          const parsed = JSON.parse(await readFile(file, 'utf8')) as {
            violations?: Array<{ id?: string; impact?: string; nodes?: unknown[] }>;
          };
          if (!Array.isArray(parsed.violations)) continue;
          scanned.add(detail.caseId);
          for (const violation of parsed.violations) {
            if (!violation.id) continue;
            const group = groups.get(violation.id) ?? {
              impact: violation.impact ?? 'minor',
              nodes: 0,
              tests: new Set<string>(),
            };
            group.nodes += Array.isArray(violation.nodes) ? violation.nodes.length : 1;
            group.tests.add(detail.caseId);
            groups.set(violation.id, group);
          }
        } catch {
          // Not an axe payload (or unreadable) — never fails the report.
        }
      }
    }
  }
  if (scanned.size === 0) return undefined;
  const violations = [...groups.entries()]
    .map(([id, g]) => ({ id, impact: g.impact, nodes: g.nodes, tests: g.tests.size }))
    .sort(
      (a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) || b.nodes - a.nodes,
    )
    .slice(0, 30);
  return { testsScanned: scanned.size, violations };
}

const LOGO_MAX_BYTES = 64 * 1024;
const LOGO_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Logo becomes a data URI so the report (and single-file export) stays self-contained. */
async function loadBranding(
  branding: WriteReportInput['branding'],
): Promise<NonNullable<Manifest['ui']>['branding']> {
  if (!branding) return undefined;
  const out: { logo?: string; accentColor?: string } = {};
  if (branding.accentColor) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(branding.accentColor)) out.accentColor = branding.accentColor;
    else console.warn(`[beacon] branding.accentColor is not a hex color: ${branding.accentColor}`);
  }
  if (branding.logo) {
    const mime = LOGO_MIME[path.extname(branding.logo).toLowerCase()];
    try {
      const body = await readFile(branding.logo);
      if (!mime) {
        console.warn(`[beacon] branding.logo must be svg/png/jpg/webp: ${branding.logo}`);
      } else if (body.byteLength > LOGO_MAX_BYTES) {
        console.warn(`[beacon] branding.logo over 64KB — ignored: ${branding.logo}`);
      } else {
        out.logo = `data:${mime};base64,${body.toString('base64')}`;
      }
    } catch {
      console.warn(`[beacon] branding.logo not readable — ignored: ${branding.logo}`);
    }
  }
  return out.logo || out.accentColor ? out : undefined;
}

/**
 * JSON-safe FullConfig excerpt for the /config page — never the whole object.
 * Every field is feature-detected: replayed fixtures and older Playwright
 * versions carry trimmed configs.
 */
function snapshotConfig(config: BeaconRunConfig): Record<string, unknown> {
  const grepText = (value: unknown): unknown =>
    value instanceof RegExp ? String(value) : Array.isArray(value) ? value.map(String) : undefined;
  const reporters = Array.isArray(config.reporter)
    ? config.reporter.flatMap((entry) =>
        Array.isArray(entry) && entry[0] !== undefined ? [path.basename(String(entry[0]))] : [],
      )
    : undefined;
  const projects = Array.isArray(config.projects)
    ? config.projects.map((p) => ({
        name: p.name,
        testDir:
          typeof p.testDir === 'string'
            ? path
                .relative(config.rootDir ?? '', p.testDir)
                .split(path.sep)
                .join('/') || '.'
            : undefined,
        timeout: p.timeout,
        retries: p.retries,
        grep: grepText(p.grep),
      }))
    : undefined;
  return {
    workers: config.workers,
    fullyParallel: config.fullyParallel,
    forbidOnly: config.forbidOnly,
    globalTimeout: config.globalTimeout || undefined,
    maxFailures: config.maxFailures || undefined,
    quiet: config.quiet || undefined,
    grep: grepText(config.grep),
    grepInvert: grepText(config.grepInvert ?? undefined),
    updateSnapshots: config.updateSnapshots,
    reporters,
    projects,
  };
}

/** Duration percentiles from sorted totals — averages lie, tails hurt. */
function computePercentiles(
  details: TestDetail[],
  projects: string[],
): Manifest['aggregates']['percentiles'] {
  const pick = (sorted: number[], p: number): number =>
    sorted.length === 0
      ? 0
      : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  const stats = (durations: number[]) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return { p50: pick(sorted, 0.5), p90: pick(sorted, 0.9), p95: pick(sorted, 0.95) };
  };
  const totalOf = (d: TestDetail) => d.results.reduce((s, r) => s + r.duration, 0);
  return {
    overall: stats(details.map(totalOf)),
    projects: projects.map((name) => ({
      name,
      ...stats(details.filter((d) => d.projectName === name).map(totalOf)),
    })),
  };
}

/** Outcome rollups grouped by a per-test key set, worst groups first. */
function rollupBy(details: TestDetail[], keysOf: (d: TestDetail) => string[]): GroupRollup[] {
  const groups = new Map<string, GroupRollup>();
  for (const detail of details) {
    for (const key of keysOf(detail)) {
      const rollup =
        groups.get(key) ??
        ({
          name: key,
          total: 0,
          expected: 0,
          unexpected: 0,
          flaky: 0,
          skipped: 0,
          duration: 0,
        } as GroupRollup);
      rollup.total += 1;
      rollup[detail.outcome] += 1;
      rollup.duration =
        (rollup.duration ?? 0) + detail.results.reduce((sum, r) => sum + r.duration, 0);
      groups.set(key, rollup);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.unexpected - a.unexpected || b.flaky - a.flaky || b.total - a.total,
  );
}

interface StringTables {
  projects: string[];
  files: string[];
  tags: string[];
  suites: string[];
  chunkOfCase: Map<string, number>;
}

/**
 * The describe chain, ' › '-joined. titlePath is
 * [root '', project, file, ...describes, title] — for playwright-bdd the
 * describes are the Feature (and Scenario Outline) names.
 */
function suiteOf(detail: TestDetail): string {
  return detail.titlePath.slice(3, -1).join(' › ');
}

function buildIndexChunk(details: TestDetail[], tables: StringTables): TestIndexChunk {
  const chunk: TestIndexChunk = {
    caseIds: [],
    titles: [],
    status: [],
    outcome: [],
    duration: [],
    project: [],
    file: [],
    tags: [],
    suite: [],
    retries: [],
    hasAttachments: [],
    detailsChunk: [],
  };
  for (const detail of details) {
    const lastResult = detail.results[detail.results.length - 1];
    chunk.caseIds.push(detail.caseId);
    chunk.titles.push(detail.title);
    chunk.status.push(Math.max(0, TEST_STATUSES.indexOf(lastResult?.status ?? 'skipped')));
    chunk.outcome.push(Math.max(0, TEST_OUTCOMES.indexOf(detail.outcome)));
    chunk.duration.push(detail.results.reduce((sum, r) => sum + r.duration, 0));
    chunk.project.push(Math.max(0, tables.projects.indexOf(detail.projectName)));
    chunk.file.push(Math.max(0, tables.files.indexOf(detail.location.file)));
    chunk.tags.push(detail.tags.map((t) => Math.max(0, tables.tags.indexOf(t))));
    chunk.suite?.push(Math.max(0, tables.suites.indexOf(suiteOf(detail))));
    chunk.retries.push(Math.max(0, detail.results.length - 1));
    chunk.hasAttachments.push(attachmentBits(detail));
    chunk.detailsChunk.push(tables.chunkOfCase.get(detail.caseId) ?? 0);
  }
  return chunk;
}

function attachmentBits(detail: TestDetail): number {
  let bits = 0;
  for (const result of detail.results) {
    for (const ref of result.attachments) {
      if (ref.contentType.startsWith('image/')) bits |= ATTACHMENT_BITS.screenshot;
      else if (ref.contentType.startsWith('video/')) bits |= ATTACHMENT_BITS.video;
      else if (ref.name === 'trace' || ref.contentType === 'application/zip')
        bits |= ATTACHMENT_BITS.trace;
      else bits |= ATTACHMENT_BITS.other;
    }
  }
  return bits;
}

/** The prebuilt SPA ships in dist/ui after the build, and in vendor/ui while tests run from source. */
export function reportUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'ui'), path.join(here, '..', '..', 'vendor', 'ui')];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

async function copyUi(
  outputDir: string,
  options: { clean: boolean } = { clean: true },
): Promise<void> {
  const uiDir = reportUiDir();
  if (existsSync(uiDir) && options.clean) {
    // Old hashed bundles would otherwise accumulate across regenerations.
    await rm(path.join(outputDir, 'assets'), { recursive: true, force: true });
  }
  if (!existsSync(uiDir)) {
    console.warn(
      '[beacon] Prebuilt UI not found next to the reporter build — the report has data files only. ' +
        'This is expected when running the reporter from source (tests); run `pnpm build` for the full report.',
    );
    return;
  }
  const indexPath = path.join(outputDir, 'index.html');
  let foreign: string | undefined;
  if (existsSync(indexPath)) {
    const current = await readFile(indexPath, 'utf8');
    if (!isBeaconPage(current)) foreign = current;
  }
  await cp(uiDir, outputDir, { recursive: true });
  if (foreign) {
    const report = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, foreign);
    await writeFile(path.join(outputDir, 'beacon.html'), report);
    console.warn(`[beacon] Left ${indexPath} in place and wrote ${path.join(outputDir, 'beacon.html')}.`);
  }
}

function isBeaconPage(html: string): boolean {
  return html.includes('beacon-cypress-report') || html.includes('window.__BEACON__') || html.includes('window.__REPORT__');
}

/** Shields-style pass-rate badge written next to the report (README embedding). */
function badgeSvg(passRate: number): string {
  const color = passRate >= 95 ? '#059669' : passRate >= 80 ? '#b45309' : '#dc2626';
  const label = 'tests';
  const value = `${passRate}% passed`;
  const lw = 6 * label.length + 12;
  const vw = 6 * value.length + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${lw}" height="20" rx="3" fill="#555"/>
<rect x="${lw}" width="${vw}" height="20" rx="3" fill="${color}"/>
<rect x="${lw}" width="3" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${label}</text>
<text x="${lw + vw / 2}" y="14">${value}</text>
</g>
</svg>
`;
}

function toChunk(key: string, data: unknown): string {
  return `window.__BEACON__.push(${jsonForScript(key)}, ${jsonForScript(data)});\n`;
}

function detectPlaywrightVersion(config: BeaconRunConfig): string | undefined {
  // FullConfig.version exists in modern Playwright; feature-detect, never version-sniff.
  const version = (config as { version?: unknown }).version;
  return typeof version === 'string' ? version : undefined;
}

function detectCi(): Manifest['meta']['ci'] {
  const env = process.env;
  if (env.GITHUB_ACTIONS) {
    return {
      provider: 'github',
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      sha: env.GITHUB_SHA,
      pullRequest: env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1],
      runUrl:
        env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined,
    };
  }
  if (env.CI) {
    return { provider: 'generic' };
  }
  return undefined;
}
