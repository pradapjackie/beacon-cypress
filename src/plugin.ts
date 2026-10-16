import { writeBeaconReport, type BeaconCypressOptions } from './write-report';
import type { CommandLog, CypressCommandLineResults } from './types';

interface CypressPluginConfig {
  projectRoot: string;
}

type PluginHandler = {
  (event: 'task', tasks: Record<string, (arg: CommandLog) => null>): void;
  (
    event: 'after:run',
    handler: (results: CypressCommandLineResults) => void | Promise<void>,
  ): void;
};

/**
 * Cypress `setupNodeEvents` entry. Pair it with `installBeaconCollector()`
 * from `beacon-cypress/support` so the command log is part of the report.
 */
export function beaconCypress(options: BeaconCypressOptions = {}) {
  return function setupNodeEvents(on: PluginHandler, config: CypressPluginConfig): void {
    const commands = new Map<string, CommandLog['commands']>();
    on('task', {
      'beacon:commands'(payload: CommandLog) {
        commands.set(payload.key, payload.commands ?? []);
        return null;
      },
    });
    on('after:run', async (results) => {
      if (!results.runs) {
        console.warn(`[beacon] Cypress run did not produce results${results.message ? `: ${results.message}` : ''}`);
        return;
      }
      try {
        const written = await writeBeaconReport(results, commands, config.projectRoot, options);
        console.log(`[beacon] Report written to ${written.outputDir} (${written.tests} tests)`);
        console.log(`[beacon] Open it with: npx beacon open ${written.outputDir}`);
      } catch (error) {
        console.warn(
          `[beacon] Report failed (Cypress run is unchanged): ${error instanceof Error ? error.message : error}`,
        );
      }
    });
  };
}
