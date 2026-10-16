import { rm } from 'node:fs/promises';
import path from 'node:path';
import { BeaconReporter, type BeaconReporterOptions } from 'beacon-reporter';
import { replayFixture } from 'beacon-reporter/replay';
import { toBeaconFixture, type CommandLogMap } from './map-results';
import { compileScrub, type ScrubRule } from './scrub';
import type { CypressCommandLineResults } from './types';

export interface BeaconCypressOptions {
  /** Report folder, resolved against the Cypress project root. Default `beacon-report`. */
  outputFolder?: string;
  title?: string;
  /** `false` turns history off. Default keeps `.beacon-history` in the project. */
  history?: false | { dir?: string; retain?: number };
  categories?: BeaconReporterOptions['categories'];
  /** `{ pattern, flags?, replacement? }[]`. An object is ignored instead of failing the report. */
  scrub?: ScrubRule[] | BeaconReporterOptions['scrub'];
  environment?: Record<string, string>;
}

export async function writeBeaconReport(
  results: CypressCommandLineResults,
  commands: CommandLogMap,
  projectRoot: string,
  options: BeaconCypressOptions = {},
): Promise<{ outputDir: string; tests: number }> {
  const runs = results.runs ?? [];
  const tests =
    runs.reduce((sum, run) => sum + (run.tests?.length ?? 0) + (run.error ? 1 : 0), 0) ||
    (results.status === 'failed' ? 1 : 0);
  const outputDir = path.resolve(projectRoot, options.outputFolder ?? 'beacon-report');
  const scrub = compileScrub(options.scrub);
  await rm(path.join(outputDir, 'attachments'), { recursive: true, force: true });
  const reporter = new BeaconReporter({
    outputFolder: outputDir,
    title: options.title ?? 'Cypress',
    history:
      options.history === false
        ? false
        : {
            dir: path.resolve(projectRoot, options.history?.dir ?? '.beacon-history'),
            retain: options.history?.retain ?? 30,
          },
    categories: options.categories,
    scrub: scrub.rules,
    environment: {
      ...(results.browserName ? { browser: results.browserName } : {}),
      ...(results.browserVersion ? { browserVersion: results.browserVersion } : {}),
      ...(results.cypressVersion ? { cypress: results.cypressVersion } : {}),
      ...(results.osName ? { os: [results.osName, results.osVersion].filter(Boolean).join(' ') } : {}),
      ...options.environment,
    },
    embedSource: false,
  });
  await replayFixture(reporter, toBeaconFixture(results, commands, scrub.apply), projectRoot);
  return { outputDir, tests };
}
