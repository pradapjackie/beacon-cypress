import path from 'node:path';
import { BeaconReporter, type BeaconReporterOptions } from 'beacon-reporter';
import { replayFixture } from 'beacon-reporter/replay';
import { toBeaconFixture } from './map-results';
import type { CypressCommand, CypressCommandLineResults } from './types';

export interface BeaconCypressOptions {
  /** Report folder, resolved against the Cypress project root. Default `beacon-report`. */
  outputFolder?: string;
  title?: string;
  /** `false` turns history off. Default keeps `.beacon-history` in the project. */
  history?: false | { dir?: string; retain?: number };
  categories?: BeaconReporterOptions['categories'];
  scrub?: BeaconReporterOptions['scrub'];
  environment?: Record<string, string>;
}

export async function writeBeaconReport(
  results: CypressCommandLineResults,
  commands: Map<string, CypressCommand[]>,
  projectRoot: string,
  options: BeaconCypressOptions = {},
): Promise<{ outputDir: string; tests: number }> {
  const runs = results.runs ?? [];
  const tests = runs.reduce((sum, run) => sum + (run.tests?.length ?? 0), 0);
  const outputDir = path.resolve(projectRoot, options.outputFolder ?? 'beacon-report');
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
    scrub: options.scrub,
    environment: {
      ...(results.browserName ? { browser: results.browserName } : {}),
      ...(results.browserVersion ? { browserVersion: results.browserVersion } : {}),
      ...(results.cypressVersion ? { cypress: results.cypressVersion } : {}),
      ...(results.osName ? { os: [results.osName, results.osVersion].filter(Boolean).join(' ') } : {}),
      ...options.environment,
    },
    embedSource: false,
  });
  await replayFixture(reporter, toBeaconFixture(results, commands), projectRoot);
  return { outputDir, tests };
}
