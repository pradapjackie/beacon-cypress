/**
 * Browser-side collector. Import this from `cypress/support/e2e.js`.
 * It has no Node dependencies, so Cypress can load it in the browser.
 */

interface CypressLog {
  id?: string;
  name?: string;
  message?: unknown;
  state?: string;
  instrument?: string;
  wallClockStartedAt?: string;
  /** Real Cypress logs expose fields through `get()`, not as own properties. */
  get?: (key: string) => unknown;
}

interface BufferedCommand {
  id: string;
  name: string;
  message: string;
  state: string;
  startedAt?: number;
}

declare const Cypress: {
  spec: { relative: string };
  on(event: 'log:added' | 'log:changed', fn: (log: CypressLog) => void): void;
};

declare function afterEach(fn: (this: { currentTest?: { titlePath: () => string[] } }) => unknown): void;

declare const cy: {
  task(name: string, arg: unknown, options?: { log?: boolean }): unknown;
};

export function commandFromLog(log: CypressLog, fallbackId: string): BufferedCommand | undefined {
  const instrument = readLog(log, 'instrument');
  if (typeof instrument === 'string' && instrument !== 'command') return undefined;
  const name = asText(readLog(log, 'name'));
  if (!name) return undefined;
  const started = asText(readLog(log, 'wallClockStartedAt'));
  const parsed = started ? Date.parse(started) : undefined;
  const id = asText(readLog(log, 'id')) || fallbackId;
  return {
    id,
    name,
    message: asText(readLog(log, 'message')),
    state: asText(readLog(log, 'state')) || 'passed',
    startedAt: parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined,
  };
}

export function installBeaconCollector(): void {
  const buffer: BufferedCommand[] = [];
  /** Ids already sent. Cypress re-emits log:changed after the test ends. */
  const reported = new Set<string>();
  let seq = 0;

  const remember = (log: CypressLog) => {
    const command = commandFromLog(log, `log-${seq}`);
    if (!command || reported.has(command.id)) return;
    const existing = buffer.find((entry) => entry.id === command.id);
    if (existing) {
      existing.message = command.message;
      existing.state = command.state;
      existing.startedAt = command.startedAt ?? existing.startedAt;
      return;
    }
    seq += 1;
    buffer.push(command);
  };

  Cypress.on('log:added', remember);
  Cypress.on('log:changed', remember);

  afterEach(function sendCommands() {
    const titles = this.currentTest?.titlePath?.() ?? [];
    const key = `${Cypress.spec.relative}::${titles.filter(Boolean).join(' > ')}`;
    const snapshot = buffer.splice(0, buffer.length);
    for (const command of snapshot) reported.add(command.id);
    const commands = snapshot.map(({ name, message, state, startedAt }) => ({
      name,
      message,
      state,
      startedAt,
    }));
    return cy.task('beacon:commands', { key, commands }, { log: false });
  });
}

function readLog(log: CypressLog, key: string): unknown {
  if (typeof log.get === 'function') return log.get(key);
  return log[key as keyof CypressLog];
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => asText(part)).join(' ');
  if (value == null) return '';
  return String(value);
}
