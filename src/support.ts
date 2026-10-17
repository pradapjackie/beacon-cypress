/**
 * Browser-side collector. Import this from `cypress/support/e2e.js`.
 * It has no Node dependencies, so Cypress can load it in the browser.
 */

import { keyForAttempt } from './keys';

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
  Screenshot?: {
    defaults(options?: {
      onAfterScreenshot?: (el: unknown, props: { path?: string; name?: string }) => unknown;
    }): {
      onAfterScreenshot?: (el: unknown, props: { path?: string; name?: string }) => unknown;
    };
  };
};

declare function afterEach(fn: (this: { currentTest?: { titlePath: () => string[] } }) => unknown): void;
declare function after(fn: () => unknown): void;

declare const cy: {
  task(name: string, arg: unknown, options?: { log?: boolean }): unknown;
};

const MAX_COMMAND_CHARS = 4_000;
const COLLECTOR_MARK = '__beaconCypressCollector';

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
  const host = globalThis as {
    Cypress?: typeof Cypress;
    afterEach?: typeof afterEach;
    after?: typeof after;
    cy?: typeof cy;
    [COLLECTOR_MARK]?: boolean;
  };
  const cypress = host.Cypress;
  if (!cypress) return;
  const flag = typeof cypress.env === 'function' ? cypress.env('BEACON_COLLECTOR') : undefined;
  if (!collectorEnabled(flag)) return;
  if (host[COLLECTOR_MARK]) return;
  host[COLLECTOR_MARK] = true;

  const buffer: BufferedCommand[] = [];
  const shots: Array<{ path: string; name?: string }> = [];
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

  cypress.on('log:added', remember);
  cypress.on('log:changed', remember);
  if (cypress.Screenshot?.defaults) {
    chainScreenshotDefaults(cypress.Screenshot, (props) => {
      if (props?.path) shots.push({ path: props.path, name: props.name });
    });
  }

  const send = (key: string, attempt: number, append: boolean) => {
    const snapshot = buffer.splice(0, buffer.length);
    const screenshots = shots.splice(0, shots.length);
    if (snapshot.length === 0 && screenshots.length === 0 && append) return;
    for (const command of snapshot) reported.add(command.id);
    const commands = snapshot.map(({ name, message, state, startedAt }) => ({
      name,
      message,
      state,
      startedAt,
    }));
    return host.cy?.task(
      'beacon:commands',
      { key, attempt, append, commands, screenshots },
      { log: false },
    );
  };

  host.afterEach?.(function sendCommands(this: { currentTest?: { titlePath: () => string[] } }) {
    const titles = (this.currentTest?.titlePath?.() ?? []).filter(Boolean);
    const retry = cypress.currentRetry ?? 0;
    lastKey = keyForAttempt(seen, cypress.spec.relative, titles, retry);
    lastAttempt = retry;
    return send(lastKey, lastAttempt, false);
  });

  // `after` hooks run in reverse registration order, so this support-file
  // hook runs after the spec's after() and can flush those commands.
  host.after?.(() => {
    if (!shouldFlushAfter(lastKey, buffer.length, shots.length)) return;
    return send(lastKey, lastAttempt, true);
  });
}

type ScreenshotHook = (el: unknown, props: { path?: string; name?: string }) => unknown;

type ScreenshotApi = {
  defaults(options?: { onAfterScreenshot?: ScreenshotHook }): { onAfterScreenshot?: ScreenshotHook };
};

/**
 * Keep a project hook that was registered before this collector, and keep
 * recording if a later `Cypress.Screenshot.defaults({ onAfterScreenshot })`
 * replaces the callback.
 */
export function chainScreenshotDefaults(
  screenshot: ScreenshotApi,
  record: (props: { path?: string; name?: string }) => void,
): void {
  const currentDefaults = screenshot.defaults as ScreenshotApi['defaults'] & { beacon?: boolean };
  if (currentDefaults.beacon) return;
  const original = screenshot.defaults.bind(screenshot);
  // Cypress rejects `defaults()` with no argument. An empty object returns the current hook.
  let userHook = original({}).onAfterScreenshot;
  const chained: ScreenshotHook = (el, props) => {
    record(props);
    return userHook?.(el, props);
  };
  const wrapped: ScreenshotApi['defaults'] & { beacon?: boolean } = (options) => {
    if (options && 'onAfterScreenshot' in options && options.onAfterScreenshot !== chained) {
      userHook = typeof options.onAfterScreenshot === 'function' ? options.onAfterScreenshot : undefined;
      return original({ ...options, onAfterScreenshot: chained });
    }
    return original(options);
  };
  wrapped.beacon = true;
  screenshot.defaults = wrapped;
  original({ onAfterScreenshot: chained });
}

/** An `after()` hook can take a `{ log: false }` screenshot and log no command. */
export function shouldFlushAfter(lastKey: string, commandCount: number, shotCount: number): boolean {
  return Boolean(lastKey) && !(commandCount === 0 && shotCount === 0);
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
