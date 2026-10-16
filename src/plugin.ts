import { writeBeaconReport, type BeaconCypressOptions } from './write-report';
import type { CommandLogMap } from './map-results';
import type { CommandLog, CypressCommand, CypressCommandLineResults } from './types';

/**
 * `any` is required so this is assignable to Cypress's `setupNodeEvents`.
 * A narrower event union makes `PluginEvents` fail TS2322.
 */
type PluginEvents = (event: any, arg?: any, arg2?: any) => void;

type PluginConfig = {
  projectRoot: string;
  env?: Record<string, unknown>;
};

type AfterRun = (results: CypressCommandLineResults) => unknown;

export function storeCommands(commands: CommandLogMap, payload: CommandLog): null {
  const stored = commands.get(payload.key);
  const attempts: CypressCommand[][] =
    stored && Array.isArray(stored[0]) ? [...(stored as CypressCommand[][])] : [];
  const index = payload.attempt ?? attempts.length;
  const next = payload.commands ?? [];
  attempts[index] = payload.append ? [...(attempts[index] ?? []), ...next] : next;
  commands.set(payload.key, attempts);
  return null;
}

/**
 * Cypress `setupNodeEvents` entry. Pair it with `installBeaconCollector()`
 * from `beacon-cypress/support` so the command log is part of the report.
 *
 * Cypress keeps a single `after:run` handler. Pass the function returned by
 * `.chain()` to other plugins so their `after:run` still runs.
 */
export function beaconCypress(options: BeaconCypressOptions = {}) {
  const setup = <T extends PluginConfig>(on: PluginEvents, config: T): T => {
    wire(on, config, options);
    return config;
  };
  setup.chain = <T extends PluginConfig>(on: PluginEvents, config: T): PluginEvents => {
    const followers: AfterRun[] = [];
    wire(on, config, options, followers);
    return (event: string, arg?: unknown) => {
      if (event === 'after:run' && typeof arg === 'function') {
        followers.push(arg as AfterRun);
        return;
      }
      on(event, arg);
    };
  };
  return setup;
}

function wire(
  on: PluginEvents,
  config: PluginConfig,
  options: BeaconCypressOptions,
  followers: AfterRun[] = [],
): void {
  config.env = { ...config.env, BEACON_COLLECTOR: true };
  const commands: CommandLogMap = new Map();
  on('task', {
    'beacon:commands'(payload: CommandLog) {
      return storeCommands(commands, payload);
    },
  });
  on('after:run', async (results: CypressCommandLineResults) => {
    try {
      const written = await writeBeaconReport(results, commands, config.projectRoot, options);
      console.log(`[beacon] Report written to ${written.outputDir} (${written.tests} tests)`);
      console.log(`[beacon] Open it with: npx beacon open ${written.outputDir}`);
    } catch (error) {
      console.warn(
        `[beacon] Report failed (Cypress run is unchanged): ${error instanceof Error ? error.message : error}`,
      );
    }
    for (const follow of followers) {
      try {
        await follow(results);
      } catch (error) {
        console.warn(
          `[beacon] A later after:run handler failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  });
}
