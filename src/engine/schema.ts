import { z } from 'zod';

/**
 * Schema v1 — the contract between the reporter (writer) and the UI (reader).
 *
 * Versioning rules (see ROADMAP.md):
 * - The UI refuses to render a manifest with a higher major version than it knows.
 * - Additive fields are minor bumps; breaking changes require a major bump and a
 *   `beacon migrate` CLI path.
 *
 * Phase 0 status: first end-to-end draft. Fields marked TODO are captured in later
 * phases but are part of the v1 surface so old reports gain features with UI upgrades.
 */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Mirrors Playwright's TestStatus. */
export const testStatusSchema = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
export type TestStatus = z.infer<typeof testStatusSchema>;

/** Mirrors TestCase.outcome(). */
export const testOutcomeSchema = z.enum(['expected', 'unexpected', 'flaky', 'skipped']);
export type TestOutcome = z.infer<typeof testOutcomeSchema>;

/** Int-encoding tables for the columnar index (row value = position here). */
export const TEST_STATUSES = testStatusSchema.options;
export const TEST_OUTCOMES = testOutcomeSchema.options;

/** hasAttachments bitmask bits. */
export const ATTACHMENT_BITS = { screenshot: 1, video: 2, trace: 4, other: 8 } as const;

/** Mirrors FullResult.status. */
export const runStatusSchema = z.enum(['passed', 'failed', 'timedout', 'interrupted']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sourceLocationSchema = z.object({
  /** Path relative to the test root. */
  file: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const errorInfoSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
  /** Playwright's own ANSI code frame — rendered as-is, never rebuilt. */
  snippet: z.string().optional(),
  location: sourceLocationSchema.optional(),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

// ---------------------------------------------------------------------------
// Attachments — content-addressed store (attachments/<sha256>.<ext>)
// ---------------------------------------------------------------------------

export const attachmentModeSchema = z.enum(['stored', 'referenced', 'inlined', 'omitted']);

export const attachmentRefSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  /** sha256 of the content; addresses attachments/<sha256>.<ext>. Absent for omitted stubs. */
  sha256: z.string().optional(),
  ext: z.string().optional(),
  /** Byte size of the original content (also recorded for omitted stubs). */
  size: z.number().int().nonnegative().optional(),
  mode: attachmentModeSchema,
  /** For mode 'referenced': original absolute path (local-only reports). */
  path: z.string().optional(),
  /** For mode 'inlined': base64 body (single-file export only). */
  body: z.string().optional(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * A toHaveScreenshot triple, detected at collect time so the UI never
 * string-matches attachment names. Values are indexes into the owning
 * result's `attachments` array.
 */
export const visualDiffSchema = z.object({
  name: z.string(),
  expected: z.number().int().nonnegative().optional(),
  actual: z.number().int().nonnegative().optional(),
  diff: z.number().int().nonnegative().optional(),
});
export type VisualDiff = z.infer<typeof visualDiffSchema>;

// ---------------------------------------------------------------------------
// Steps — recursive tree mirroring TestStep
// ---------------------------------------------------------------------------

export interface StepNode {
  title: string;
  /** TestStep.category: 'hook' | 'expect' | 'pw:api' | 'test.step' | 'fixture' | ... */
  category: string;
  /** Epoch ms. */
  startTime: number;
  duration: number;
  error?: ErrorInfo;
  /** Indexes into the owning result's `attachments` array (step-level attachments). */
  attachments: number[];
  steps: StepNode[];
}

export const stepNodeSchema: z.ZodType<StepNode> = z.lazy(() =>
  z.object({
    title: z.string(),
    category: z.string(),
    startTime: z.number(),
    duration: z.number(),
    error: errorInfoSchema.optional(),
    attachments: z.array(z.number().int().nonnegative()),
    steps: z.array(stepNodeSchema),
  }),
);

// ---------------------------------------------------------------------------
// Test results & details
// ---------------------------------------------------------------------------

export const annotationSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const stdioChunkSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  /** Text with ANSI preserved; binary chunks are base64 with `base64: true`. */
  text: z.string(),
  base64: z.boolean().optional(),
});
export type StdioChunk = z.infer<typeof stdioChunkSchema>;

/** One attempt (TestResult) — a test has one record per retry. */
export const testResultRecordSchema = z.object({
  retry: z.number().int().nonnegative(),
  workerIndex: z.number().int(),
  parallelIndex: z.number().int(),
  /** Epoch ms. */
  startTime: z.number(),
  duration: z.number(),
  status: testStatusSchema,
  errors: z.array(errorInfoSchema),
  stdio: z.array(stdioChunkSchema),
  attachments: z.array(attachmentRefSchema),
  steps: z.array(stepNodeSchema),
  visualDiffs: z.array(visualDiffSchema),
  /** Result-level annotations (Playwright >= 1.47 field; feature-detected). */
  annotations: z.array(annotationSchema).optional(),
});
export type TestResultRecord = z.infer<typeof testResultRecordSchema>;

/** Full per-test record, stored in details/chunk-N.js grouped by spec file. */
export const testDetailSchema = z.object({
  /** Stable across Playwright versions: sha1(projectName + file + titlePath). */
  caseId: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()),
  location: sourceLocationSchema,
  projectName: z.string(),
  tags: z.array(z.string()),
  annotations: z.array(annotationSchema),
  outcome: testOutcomeSchema,
  timeout: z.number(),
  slow: z.boolean(),
  /** Failure category name (reporter rules + built-ins), set on failing tests. */
  category: z.string().optional(),
  /**
   * Outcome per retained history run (index into TEST_OUTCOMES, -1 = not in
   * that run), oldest → newest with the current run last.
   */
  history: z.array(z.number().int()).optional(),
  /** This test's duration (ms) per retained run, aligned with `history`. */
  historyDurations: z.array(z.number()).optional(),
  /** Consecutive failing runs ending with this one (set when >= 2). */
  failingStreak: z.number().int().optional(),
  /** Custom metrics from `beacon:metrics` JSON attachments (last attempt wins). */
  metrics: z.record(z.number()).optional(),
  /** Duration budget in ms, from a `budget` annotation ("2s", "1500ms", "1500"). */
  budgetMs: z.number().optional(),
  /** Shard that ran this test (single-shard runs; merged blobs lack it). */
  shard: z.number().int().nonnegative().optional(),
  /**
   * Source snippet around the test's location (failures always; whole runs
   * only under the smallness threshold). For playwright-bdd, the mapped
   * .feature scenario when the file can be found.
   */
  source: z
    .object({
      file: z.string(),
      /** 1-based line number of lines[0]. */
      startLine: z.number().int().positive(),
      lines: z.array(z.string()),
      /** Absolute (1-based) line to highlight — the failing line when known. */
      highlightLine: z.number().int().positive().optional(),
      language: z.enum(['ts', 'feature']).optional(),
    })
    .optional(),
  results: z.array(testResultRecordSchema),
});
export type TestDetail = z.infer<typeof testDetailSchema>;

// ---------------------------------------------------------------------------
// Columnar list index — data/index/chunk-N.js (~40–60 bytes/test)
// ---------------------------------------------------------------------------

/**
 * Parallel arrays; row i describes one test. Small ints reference string
 * tables in the manifest (projects, files, tags). Filtering runs over these
 * arrays in a Web Worker without materializing per-test objects.
 */
export const testIndexChunkSchema = z.object({
  caseIds: z.array(z.string()),
  titles: z.array(z.string()),
  /** Index into testStatusSchema.options (status of the final attempt). */
  status: z.array(z.number().int().nonnegative()),
  /** Index into testOutcomeSchema.options. */
  outcome: z.array(z.number().int().nonnegative()),
  /** Total duration across attempts, ms. */
  duration: z.array(z.number()),
  /** Index into manifest.projects. */
  project: z.array(z.number().int().nonnegative()),
  /** Index into manifest.files. */
  file: z.array(z.number().int().nonnegative()),
  /** Rows of indexes into manifest.tags. */
  tags: z.array(z.array(z.number().int().nonnegative())),
  /**
   * Index into manifest.suites — the describe chain (e.g. a BDD Feature /
   * Scenario Outline from playwright-bdd), '' when the test has no describes.
   * Optional: absent in reports written before schema minor 1.1.
   */
  suite: z.array(z.number().int().nonnegative()).optional(),
  retries: z.array(z.number().int().nonnegative()),
  /** Bitmask: 1 screenshot, 2 video, 4 trace, 8 other. */
  hasAttachments: z.array(z.number().int().nonnegative()),
  /** Index of the details chunk holding each test's TestDetail. */
  detailsChunk: z.array(z.number().int().nonnegative()),
});
export type TestIndexChunk = z.infer<typeof testIndexChunkSchema>;

// ---------------------------------------------------------------------------
// Run metadata & manifest — data/manifest.js (dashboard renders from this alone)
// ---------------------------------------------------------------------------

export const ciInfoSchema = z.object({
  provider: z.string().optional(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  pullRequest: z.string().optional(),
  runUrl: z.string().optional(),
});
export type CiInfo = z.infer<typeof ciInfoSchema>;

export const projectInfoSchema = z.object({
  name: z.string(),
  /** TODO Phase 2: browser/device snapshot from project.use. */
  use: z.record(z.unknown()).optional(),
});

export const runMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  beaconVersion: z.string(),
  playwrightVersion: z.string().optional(),
  generatedAt: z.number(),
  startTime: z.number(),
  duration: z.number(),
  status: runStatusSchema,
  ci: ciInfoSchema.optional(),
  /** Absolute project root — only recorded when editor links are enabled. */
  rootDir: z.string().optional(),
  config: z.object({
    workers: z.number().int().positive().optional(),
    fullyParallel: z.boolean().optional(),
    shard: z.object({ current: z.number().int(), total: z.number().int() }).nullish(),
    /** TODO Phase 2: full config snapshot page. */
  }),
  /** Run-level errors: global setup/teardown failures, onError events. */
  errors: z.array(errorInfoSchema),
  /** JSON-safe FullConfig excerpt rendered on the /config page. */
  configSnapshot: z.record(z.unknown()).optional(),
  /**
   * True on interim writes while tests are still running (watch mode).
   * The UI polls and refreshes until this clears on the final write.
   */
  inProgress: z.boolean().optional(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

export const runCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  unexpected: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type RunCounts = z.infer<typeof runCountsSchema>;

export const slowTestSchema = z.object({
  caseId: z.string(),
  title: z.string(),
  projectName: z.string(),
  duration: z.number(),
});
export type SlowTest = z.infer<typeof slowTestSchema>;

export const projectRollupSchema = runCountsSchema.extend({ name: z.string() });
export type ProjectRollup = z.infer<typeof projectRollupSchema>;

/** Outcome rollup for any grouping dimension (tag/marker, file, …). */
export const groupRollupSchema = runCountsSchema.extend({
  name: z.string(),
  /** Total duration of the group's tests, ms (files card shows it). */
  duration: z.number().optional(),
});
export type GroupRollup = z.infer<typeof groupRollupSchema>;

/** Dashboard card ids, in default order. The reporter option validates against this. */
export const DASHBOARD_CARDS = [
  'outcomes',
  'trend',
  'slowest',
  'projects',
  'tags',
  'files',
  'suites',
  'categories',
  'failing',
  'durations',
  'environment',
  'treemap',
  'severity',
  'slowed',
  'incidents',
  'owners',
  'health',
  'waste',
  'budgets',
  'metrics',
  'heatmap',
  'steps',
  'a11y',
  'percentiles',
  'coverage',
  'requirements',
] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];
/** Every built-in card. A report with no `dashboard.cards` option shows this set. */
export const DEFAULT_DASHBOARD_CARDS: DashboardCard[] = [...DASHBOARD_CARDS];

/** One attempt on the worker timeline; `start` is ms relative to the run start. */
export const timelineEntrySchema = z.object({
  caseId: z.string(),
  title: z.string(),
  projectName: z.string(),
  workerIndex: z.number().int(),
  start: z.number(),
  duration: z.number(),
  /** Index into TEST_OUTCOMES (the owning test's final outcome). */
  outcome: z.number().int().nonnegative(),
  retry: z.number().int().nonnegative(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/**
 * data/timeline.js — worker lanes in their own chunk so the manifest stays
 * small (the dashboard never needs lanes; only the /timeline page loads them).
 * Older reports carry `aggregates.timeline` in the manifest instead.
 */
export const timelineDataSchema = z.object({
  entries: z.array(timelineEntrySchema),
  truncated: z.boolean().optional(),
});
export type TimelineData = z.infer<typeof timelineDataSchema>;

export const manifestSchema = z.object({
  meta: runMetaSchema,
  counts: runCountsSchema,
  /** String tables referenced by columnar index chunks. */
  projects: z.array(projectInfoSchema),
  files: z.array(z.string()),
  tags: z.array(z.string()),
  /** Describe-chain table ('' = no describes); BDD features land here. */
  suites: z.array(z.string()).optional(),
  chunks: z.object({
    /** Number of index/chunk-N.js files. */
    index: z.number().int().nonnegative(),
    /** Number of details/chunk-N.js files. */
    details: z.number().int().nonnegative(),
  }),
  /**
   * Precomputed aggregates consumed directly by dashboard charts.
   * TODO Phase 2+: duration histogram, worker timeline lanes; Phase 3:
   * trend series, category counts.
   */
  /** How the UI should present this report — from reporter options. */
  ui: z
    .object({
      title: z.string().optional(),
      cards: z.array(z.string()),
      /** URL templates per annotation type, `{}` = the annotation description. */
      links: z.record(z.string()).optional(),
      /** Render open-in-editor links (needs meta.rootDir; local reports only). */
      editorLinks: z.boolean().optional(),
      /** White-labeling: logo as a data URI, accent as a hex color. */
      branding: z
        .object({
          logo: z.string().optional(),
          accentColor: z.string().optional(),
        })
        .optional(),
      /** Plugin-produced dashboard cards (rendered after the built-ins). */
      customCards: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            subtitle: z.string().optional(),
            rows: z.array(z.object({ label: z.string(), value: z.string() })),
          }),
        )
        .optional(),
    })
    .optional(),
  /** User-supplied + auto-detected environment key-values. */
  environment: z.record(z.string()).optional(),
  aggregates: z
    .object({
      slowest: z.array(slowTestSchema).optional(),
      projects: z.array(projectRollupSchema).optional(),
      tags: z.array(groupRollupSchema).optional(),
      files: z.array(groupRollupSchema).optional(),
      /** Describe chains / BDD features (playwright-bdd Feature: blocks). */
      suites: z.array(groupRollupSchema).optional(),
      categories: z.array(groupRollupSchema).optional(),
      /** From `severity: <level>` annotations. */
      severity: z.array(groupRollupSchema).optional(),
      /** From `owner: <name>` annotations. */
      owners: z.array(groupRollupSchema).optional(),
      /** Tests significantly slower than their history median. */
      slowedDown: z
        .array(
          z.object({
            caseId: z.string(),
            title: z.string(),
            projectName: z.string(),
            current: z.number(),
            median: z.number(),
            factor: z.number(),
          }),
        )
        .optional(),
      /** Retry & failure cost accounting. */
      waste: z
        .object({
          retryMs: z.number(),
          failedMs: z.number(),
          retriedTests: z.number().int(),
          rescued: z.number().int(),
          attempts: z.number().int(),
        })
        .optional(),
      /** Composite suite health, 0-100. */
      health: z
        .object({
          score: z.number(),
          passRate: z.number(),
          flakyShare: z.number(),
          failShare: z.number(),
        })
        .optional(),
      /** Tests over their duration budget. */
      budgets: z
        .array(
          z.object({
            caseId: z.string(),
            title: z.string(),
            projectName: z.string(),
            duration: z.number(),
            budget: z.number(),
          }),
        )
        .optional(),
      /** Custom metric rollups across tests. */
      metrics: z
        .array(
          z.object({
            name: z.string(),
            count: z.number().int(),
            avg: z.number(),
            max: z.number(),
          }),
        )
        .optional(),
      /** Failing tests grouped by normalized error — one root cause, many tests. */
      incidents: z
        .array(
          z.object({
            message: z.string(),
            tests: z.array(
              z.object({ caseId: z.string(), title: z.string(), projectName: z.string() }),
            ),
          }),
        )
        .optional(),
      /** Duration histogram buckets, in bucket order. */
      durations: z.array(z.object({ label: z.string(), count: z.number().int() })).optional(),
      /** Serialized (sum of attempts) vs wall-clock time. */
      speedup: z
        .object({ serialized: z.number(), wall: z.number(), factor: z.number() })
        .optional(),
      timeline: z.array(timelineEntrySchema).optional(),
      /** True when the timeline was capped (very large runs). */
      timelineTruncated: z.boolean().optional(),
      /** Per-test flakiness across retained runs (EWMA of flaky/alternating outcomes). */
      flakiness: z
        .array(
          z.object({
            caseId: z.string(),
            title: z.string(),
            projectName: z.string(),
            /** 0–100; recency-weighted. */
            score: z.number(),
            flakyRuns: z.number().int(),
            failedRuns: z.number().int(),
            runs: z.number().int(),
          }),
        )
        .optional(),
      /** Leaf pw:api/expect steps aggregated by normalized title, worst first. */
      slowestSteps: z
        .array(
          z.object({
            title: z.string(),
            category: z.string(),
            count: z.number().int(),
            totalMs: z.number(),
            avgMs: z.number(),
            maxMs: z.number(),
          }),
        )
        .optional(),
      /** Duration percentiles (ms) overall and per project. */
      percentiles: z
        .object({
          overall: z.object({ p50: z.number(), p90: z.number(), p95: z.number() }),
          projects: z.array(
            z.object({
              name: z.string(),
              p50: z.number(),
              p90: z.number(),
              p95: z.number(),
            }),
          ),
        })
        .optional(),
      /** Current failures split: first-time vs failing ≥2 runs in a row. */
      failureFreshness: z.object({ fresh: z.number().int(), known: z.number().int() }).optional(),
      /** Content-addressed attachment store stats (dedupe savings). */
      storage: z
        .object({
          count: z.number().int(),
          unique: z.number().int(),
          bytes: z.number(),
          dedupedBytes: z.number(),
        })
        .optional(),
      /** Code coverage, ingested from an istanbul coverage-summary.json. */
      coverage: z
        .object({
          lines: z.number(),
          statements: z.number(),
          functions: z.number(),
          branches: z.number(),
          /** Worst-covered files (by line pct), ascending. */
          files: z.array(z.object({ name: z.string(), lines: z.number() })),
        })
        .optional(),
      /** Rollups per `requirement: <id>` annotation. */
      requirements: z.array(groupRollupSchema).optional(),
      /** Requirement → tests matrix (capped), for the /requirements page. */
      requirementsMatrix: z
        .array(
          z.object({
            id: z.string(),
            tests: z.array(
              z.object({
                caseId: z.string(),
                title: z.string(),
                projectName: z.string(),
                /** Index into TEST_OUTCOMES. */
                outcome: z.number().int(),
              }),
            ),
          }),
        )
        .optional(),
      /** Axe violations aggregated across `axe`-named JSON attachments. */
      a11y: z
        .object({
          testsScanned: z.number().int(),
          violations: z.array(
            z.object({
              id: z.string(),
              impact: z.string(),
              nodes: z.number().int(),
              tests: z.number().int(),
            }),
          ),
        })
        .optional(),
    })
    .catchall(z.unknown()),
});
export type Manifest = z.infer<typeof manifestSchema>;

// ---------------------------------------------------------------------------
// History — .beacon-history/runs/<ts>_<runId>.json (reporter-side persistence)
// ---------------------------------------------------------------------------

/** Compact per-test tuple: [outcome index, duration ms, retries]. */
export const historyCaseSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number(),
  z.number().int().nonnegative(),
]);

export const historyRunSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string(),
  startTime: z.number(),
  duration: z.number(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  runUrl: z.string().optional(),
  counts: runCountsSchema,
  cases: z.record(historyCaseSchema),
  /** Per-metric mean across the run's tests (beacon:metrics convention). */
  metrics: z.record(z.number()).optional(),
  /** Overall line-coverage percentage for this run, when ingested. */
  coverage: z.number().optional(),
});
export type HistoryRun = z.infer<typeof historyRunSchema>;

/** data/history.js — trends and deltas embedded in the report at generate time. */
export const historyRunSummarySchema = z.object({
  runId: z.string(),
  startTime: z.number(),
  duration: z.number(),
  counts: runCountsSchema,
  /** Total retries across the run's tests. */
  retries: z.number().int().nonnegative().optional(),
  /** Overall line-coverage percentage (coverage trend). */
  coverage: z.number().optional(),
});
export const historyDataSchema = z.object({
  /** Oldest → newest, current run last. */
  runs: z.array(historyRunSummarySchema),
  /** caseIds, vs the previous run. */
  transitions: z.object({
    added: z.array(z.string()),
    fixed: z.array(z.string()),
    regressed: z.array(z.string()),
  }),
  /** Tests failing most often across retained runs (only tests in the current run). */
  mostFailing: z.array(
    z.object({
      caseId: z.string(),
      title: z.string(),
      projectName: z.string(),
      failures: z.number().int(),
      runs: z.number().int(),
    }),
  ),
  /** Per-metric mean per retained run, aligned with `runs` (null = not recorded). */
  metricTrends: z
    .array(z.object({ name: z.string(), values: z.array(z.number().nullable()) }))
    .optional(),
});
export type HistoryData = z.infer<typeof historyDataSchema>;

/**
 * data/compare.js — the current run diffed against every retained baseline,
 * computed at generate time (the /compare page is pure rendering). caseIds in
 * removed are absent from the current run, so they render without titles.
 */
export const compareBaselineSchema = z.object({
  runId: z.string(),
  startTime: z.number(),
  counts: runCountsSchema,
  regressed: z.array(z.string()),
  fixed: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  /** ≥1.25× and ≥50ms slower than the baseline, worst first (capped). */
  slower: z.array(z.object({ caseId: z.string(), from: z.number(), to: z.number() })),
  /** ≤0.8× the baseline duration, best first (capped). */
  faster: z.array(z.object({ caseId: z.string(), from: z.number(), to: z.number() })),
});
export const compareDataSchema = z.object({
  /** Oldest → newest; the current run itself is not a baseline. */
  baselines: z.array(compareBaselineSchema),
});
export type CompareData = z.infer<typeof compareDataSchema>;
export type CompareBaseline = z.infer<typeof compareBaselineSchema>;

/**
 * data/errors.js — caseId → lowercased error text (message + snippet, capped),
 * so "search in errors" is a plain map lookup at any suite size.
 */
export const errorIndexSchema = z.record(z.string());
export type ErrorIndex = z.infer<typeof errorIndexSchema>;
