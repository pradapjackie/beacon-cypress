import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from './engine/writer';
import {
  toCypressReport,
  type CommandLogMap,
  type RecordedScreenshots,
} from './map-results';
import { compileScrub, type ScrubRule } from './scrub';
import { toTestDetails } from './to-details';
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
  /** Dashboard cards, in order. Unknown ids are dropped. */
  dashboard?: { cards?: string[]; slowest?: number };
  /** URL templates per annotation type. `{}` is the annotation description. */
  links?: Record<string, string>;
  /** Logo path (svg, png, jpg, or webp, at most 64KB) and an accent hex color. */
  branding?: { logo?: string; accentColor?: string };
  /** Record the project root so the report can open files in an editor. */
  editorLinks?: boolean;
  /** Path to an istanbul `coverage-summary.json`. */
  coverage?: string;
  /** Rewrite the report after each spec while the run is still going. */
  watch?: boolean;
}

export async function writeBeaconReport(
  results: CypressCommandLineResults,
  commands: CommandLogMap,
  projectRoot: string,
  options: BeaconCypressOptions = {},
  recordedShots?: RecordedScreenshots,
  runtime: { inProgress?: boolean } = {},
): Promise<{ outputDir: string; tests: number }> {
  const outputDir = path.resolve(projectRoot, options.outputFolder ?? 'beacon-report');
  const scrub = compileScrub(options.scrub);
  await mkdir(outputDir, { recursive: true });
  if (!runtime.inProgress) await clearPreviousAttachments(outputDir);

  const mapped = toCypressReport(results, commands, scrub.apply, recordedShots);
  const { details, owned } = await toTestDetails(mapped, outputDir);
  const projectName = mapped.browser || 'cypress';
  const history =
    runtime.inProgress || options.history === false
      ? undefined
      : {
          dir: path.resolve(projectRoot, options.history?.dir ?? '.beacon-history'),
          retain: options.history?.retain ?? 30,
        };

  await writeReport({
    outputDir,
    status: mapped.status === 'failed' ? 'failed' : 'passed',
    startTime: mapped.startedAt || Date.now(),
    duration: mapped.duration,
    details,
    errors: results.message ? [{ message: scrub.apply(results.message) }] : [],
    config: {
      rootDir: options.editorLinks ? projectRoot : undefined,
      workers: 1,
      fullyParallel: false,
      projects: [{ name: projectName, testDir: 'cypress/e2e' }],
    },
    copyUi: true,
    title: options.title,
    dashboard: options.dashboard,
    environment: {
      ...(results.browserName ? { browser: results.browserName } : {}),
      ...(results.browserVersion ? { browserVersion: results.browserVersion } : {}),
      ...(results.cypressVersion ? { cypress: results.cypressVersion } : {}),
      ...(results.osName ? { os: [results.osName, results.osVersion].filter(Boolean).join(' ') } : {}),
      node: process.version,
      ...options.environment,
    },
    links: options.links,
    categories: options.categories,
    history,
    editorLinks: options.editorLinks,
    branding: options.branding?.logo
      ? { ...options.branding, logo: path.resolve(projectRoot, options.branding.logo) }
      : options.branding,
    inProgress: runtime.inProgress,
    beaconVersion: packageVersion(),
    coveragePath: options.coverage ? path.resolve(projectRoot, options.coverage) : undefined,
  });

  if (!runtime.inProgress) {
    await writeFile(path.join(outputDir, 'data', 'owned.json'), `${JSON.stringify(owned)}\n`);
  }
  return { outputDir, tests: details.length };
}

async function clearPreviousAttachments(outputDir: string): Promise<void> {
  let listed: unknown;
  try {
    listed = JSON.parse(await readFile(path.join(outputDir, 'data', 'owned.json'), 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(listed)) return;
  const root = path.resolve(outputDir, 'attachments');
  for (const entry of listed) {
    if (typeof entry !== 'string' || !entry.startsWith('attachments/') || entry.includes('..')) continue;
    const target = path.resolve(outputDir, entry);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    await rm(target, { force: true });
  }
}

function packageVersion(): string {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(readFileSync(file, 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}
