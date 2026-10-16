/**
 * Browser-side collector. Import this from `cypress/support/e2e.js`.
 * It has no Node dependencies, so Cypress can load it in the browser.
 */

import { commandKey, duplicateIndex } from './keys';

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
  /** Zero on the first try, then 1, 2, … for retries. */
  currentRetry: number;
  env(key: string): unknown;
  on(event: 'log:added' | 'log:changed', fn: (log: CypressLog) => void): void;
};

declare function afterEach(fn: (this: { currentTest?: { titlePath: () => string[] } }) => unknown): void;
declare function after(fn: () => unknown): void;

declare const cy: {
  task(name: string, arg: unknown, options?: { log?: boolean }): unknown;
};

const MAX_COMMAND_CHARS = 4_000;

export function collectorEnabled(value: unknown): boolean {
  return value === true || value === 'true';
}

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
  const flag = typeof Cypress.env === 'function' ? Cypress.env('BEACON_COLLECTOR') : undefined;
  if (!collectorEnabled(flag)) return;

  const buffer: BufferedCommand[] = [];
  /** Ids already sent. Cypress re-emits log:changed after the test ends. */
  const reported = new Set<string>();
  const seen = new Map<string, number>();
  let seq = 0;
  let lastKey = '';
  let lastAttempt = 0;

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

  const send = (key: string, attempt: number, append: boolean) => {
    const snapshot = buffer.splice(0, buffer.length);
    if (snapshot.length === 0 && append) return;
    for (const command of snapshot) reported.add(command.id);
    const commands = snapshot.map(({ name, message, state, startedAt }) => ({
      name,
      message,
      state,
      startedAt,
    }));
    return cy.task('beacon:commands', { key, attempt, append, commands }, { log: false });
  };

  afterEach(function sendCommands() {
    const titles = this.currentTest?.titlePath?.() ?? [];
    const duplicate = duplicateIndex(seen, titles.filter(Boolean));
    lastKey = commandKey(Cypress.spec.relative, titles.filter(Boolean), duplicate);
    lastAttempt = Cypress.currentRetry ?? 0;
    return send(lastKey, lastAttempt, false);
  });

  // `after` hooks run in reverse registration order, so this support-file
  // hook runs after the spec's after() and can flush those commands.
  after(() => {
    if (!lastKey || buffer.length === 0) return;
    return send(lastKey, lastAttempt, true);
  });
}

function readLog(log: CypressLog, key: string): unknown {
  if (typeof log.get === 'function') return log.get(key);
  return log[key as keyof CypressLog];
}

function asText(value: unknown): string {
  return clip(textOf(value));
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => textOf(part)).filter(Boolean).join(' ');
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as { message?: unknown };
    if (typeof record.message === 'string' || typeof record.message === 'number') return String(record.message);
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}' && json !== '[]') return json;
    } catch {
      return '';
    }
    return '';
  }
  return String(value);
}

function clip(value: string): string {
  if (value.length <= MAX_COMMAND_CHARS) return value;
  return `${value.slice(0, MAX_COMMAND_CHARS)}…`;
}
