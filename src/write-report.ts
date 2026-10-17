import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  toCypressReport,
  type CommandLogMap,
  type RecordedScreenshots,
  type ReportTest,
} from './map-results';
import { renderReportHtml } from './report-page';
import { compileScrub, type ScrubRule } from './scrub';
import type { CypressCommandLineResults } from './types';

export interface BeaconCypressOptions {
  /** Report folder, resolved against the Cypress project root. Default `beacon-report`. */
  outputFolder?: string;
  title?: string;
  /** `false` turns history off. Default keeps `.beacon-history` in the project. */
  history?: false | { dir?: string; retain?: number };
  categories?: Array<{ name: string; messageRegex?: string; stackRegex?: string }>;
  /** `{ pattern, flags?, replacement? }[]`. An object is ignored instead of failing the report. */
  scrub?: ScrubRule[];
  environment?: Record<string, string>;
}

export interface ReportCounts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

interface HistoryPoint {
  kind: 'cypress';
  at: string;
  status: 'passed' | 'failed';
  duration: number;
  counts: ReportCounts;
  tests: Array<{ id: string; title: string; spec: string; outcome: ReportTest['outcome']; duration: number }>;
}

const DEFAULT_CATEGORIES = [
  { name: 'Assertion', messageRegex: 'assert|expected' },
  { name: 'Timeout', messageRegex: 'timed out|timeout' },
];

export async function writeBeaconReport(
  results: CypressCommandLineResults,
  commands: CommandLogMap,
  projectRoot: string,
  options: BeaconCypressOptions = {},
  recordedShots?: RecordedScreenshots,
): Promise<{ outputDir: string; tests: number }> {
  const outputDir = path.resolve(projectRoot, options.outputFolder ?? 'beacon-report');
  const scrub = compileScrub(options.scrub);
  await mkdir(outputDir, { recursive: true });
  await clearPreviousAttachments(outputDir);

  const mapped = toCypressReport(results, commands, scrub.apply, recordedShots);
  await localizeFiles(outputDir, mapped.tests);
  categorize(mapped.tests, options.categories ?? DEFAULT_CATEGORIES);

  const counts = countTests(mapped.tests);
  const history = await remember(projectRoot, options, {
    kind: 'cypress',
    at: new Date().toISOString(),
    status: mapped.status,
    duration: mapped.duration,
    counts,
    tests: mapped.tests.map((test) => ({
      id: test.id,
      title: test.title,
      spec: test.spec,
      outcome: test.outcome,
      duration: test.duration,
    })),
  });

  const report = {
    title: options.title ?? 'Cypress',
    generatedAt: new Date().toISOString(),
    startedAt: mapped.startedAt,
    duration: mapped.duration,
    status: mapped.status,
    environment: {
      ...(results.browserName ? { browser: results.browserName } : {}),
      ...(results.browserVersion ? { browserVersion: results.browserVersion } : {}),
      ...(results.cypressVersion ? { cypress: results.cypressVersion } : {}),
      ...(results.osName ? { os: [results.osName, results.osVersion].filter(Boolean).join(' ') } : {}),
      node: process.version,
      ...options.environment,
    },
    counts,
    tests: mapped.tests,
    history,
  };

  await mkdir(path.join(outputDir, 'data'), { recursive: true });
  await writeFile(path.join(outputDir, 'data', 'report.json'), JSON.stringify(report));
  await writeFile(path.join(outputDir, 'index.html'), renderReportHtml(report));
  return { outputDir, tests: mapped.tests.length };
}

/** Only a previous Cypress Beacon report owns `attachments/`. A plain folder with that name is left alone. */
async function clearPreviousAttachments(outputDir: string): Promise<void> {
  try {
    await access(path.join(outputDir, 'data', 'report.json'));
  } catch {
    return;
  }
  await rm(path.join(outputDir, 'attachments'), { recursive: true, force: true });
}

async function localizeFiles(outputDir: string, tests: ReportTest[]): Promise<void> {
  const cache = new Map<string, string | undefined>();
  const local = async (file: string): Promise<string | undefined> => {
    if (cache.has(file)) return cache.get(file);
    let rel: string | undefined;
    try {
      const bytes = await readFile(file);
      const ext = path.extname(file).toLowerCase();
      const name = createHash('sha1').update(bytes).digest('hex').slice(0, 16) + ext;
      rel = `attachments/${name}`;
      await mkdir(path.join(outputDir, 'attachments'), { recursive: true });
      await writeFile(path.join(outputDir, 'attachments', name), bytes);
    } catch {
      rel = undefined;
    }
    cache.set(file, rel);
    return rel;
  };

  for (const test of tests) {
    for (const attempt of test.attempts) {
      const shots = [];
      for (const shot of attempt.screenshots) {
        const rel = await local(shot.path);
        if (rel) shots.push({ name: shot.name, path: rel });
      }
      attempt.screenshots = shots;
      if (attempt.video) {
        const rel = await local(attempt.video.path);
        attempt.video = rel ? { name: attempt.video.name, path: rel } : undefined;
      }
    }
  }
}

function categorize(
  tests: ReportTest[],
  rules: Array<{ name: string; messageRegex?: string; stackRegex?: string }>,
): void {
  const compiled: Array<{ name: string; message?: RegExp; stack?: RegExp }> = [];
  for (const rule of rules) {
    if (!rule || typeof rule.name !== 'string') continue;
    const message = compilePattern(rule.messageRegex);
    const stack = compilePattern(rule.stackRegex);
    if (message || stack) compiled.push({ name: rule.name, message, stack });
  }
  for (const test of tests) {
    if (test.outcome !== 'failed' && test.outcome !== 'flaky') continue;
    const match = compiled.find((rule) =>
      test.attempts.some(
        (attempt) =>
          Boolean(rule.message && rule.message.test(attempt.error?.message ?? '')) ||
          Boolean(rule.stack && rule.stack.test(attempt.error?.stack ?? '')),
      ),
    );
    test.category = match?.name ?? (test.outcome === 'failed' ? 'Other' : undefined);
  }
}

function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

function countTests(tests: ReportTest[]): ReportCounts {
  const counts: ReportCounts = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const test of tests) counts[test.outcome] += 1;
  return counts;
}

async function remember(
  projectRoot: string,
  options: BeaconCypressOptions,
  point: HistoryPoint,
): Promise<HistoryPoint[]> {
  if (options.history === false) return [];
  const dir = path.resolve(projectRoot, options.history?.dir ?? '.beacon-history');
  const retain = options.history?.retain ?? 30;
  try {
    await mkdir(dir, { recursive: true });
    const stamp = `${point.at.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(path.join(dir, `${stamp}.json`), JSON.stringify(point));
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    const owned: Array<{ name: string; point: HistoryPoint }> = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as HistoryPoint;
        if (parsed?.kind === 'cypress') owned.push({ name, point: parsed });
      } catch {
        // Leave files that are not Cypress history where they are.
      }
    }
    const extra = owned.length - retain;
    if (extra > 0) {
      for (const item of owned.slice(0, extra)) await rm(path.join(dir, item.name), { force: true });
      return owned.slice(extra).map((item) => item.point);
    }
    return owned.map((item) => item.point);
  } catch (error) {
    console.warn(`[beacon] History was not saved: ${error instanceof Error ? error.message : error}`);
    return [point];
  }
}
