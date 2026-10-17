import { describe, expect, it } from 'vitest';
import { chainScreenshotDefaults, collectorEnabled, commandFromLog, shouldFlushAfter } from '../src/support';

describe('commandFromLog', () => {
  it('reads a Cypress log object through get()', () => {
    const fields: Record<string, unknown> = {
      id: 'log-7',
      name: 'get',
      message: ['#email'],
      state: 'failed',
      instrument: 'command',
      wallClockStartedAt: '2026-10-16T12:00:01.000Z',
    };
    const command = commandFromLog({ get: (key) => fields[key] }, 'fallback');
    expect(command).toMatchObject({
      id: 'log-7',
      name: 'get',
      message: '#email',
      state: 'failed',
      startedAt: Date.parse('2026-10-16T12:00:01.000Z'),
    });
  });

  it('ignores hooks and keeps plain attribute logs', () => {
    expect(commandFromLog({ name: 'visit', instrument: 'hook' }, 'fallback')).toBeUndefined();
    expect(commandFromLog({ name: 'visit', message: '/' }, 'fallback')?.name).toBe('visit');
  });

  it('turns object messages into text and caps long ones', () => {
    expect(commandFromLog({ name: 'log', message: { token: 'abc' } }, 'fallback')?.message).toBe('{"token":"abc"}');
    const command = commandFromLog({ name: 'request', message: 'z'.repeat(5_000) }, 'fallback');
    expect(command?.message.endsWith('…')).toBe(true);
    expect(command?.message.length).toBe(4_001);
  });

  it('treats a missing plugin flag as disabled', () => {
    expect(collectorEnabled(undefined)).toBe(false);
    expect(collectorEnabled(true)).toBe(true);
  });
});

describe('screenshot hooks', () => {
  function fakeScreenshot(initial?: (el: unknown, props: { path?: string }) => void) {
    let hook = initial;
    return {
      defaults(options?: { onAfterScreenshot?: typeof initial }) {
        if (options == null || typeof options !== 'object') {
          throw new Error('`Cypress.Screenshot.defaults()` must be called with an object. You passed: ``');
        }
        if (typeof options.onAfterScreenshot === 'function') hook = options.onAfterScreenshot;
        return { onAfterScreenshot: hook };
      },
    };
  }

  it('runs a hook that was registered first, then keeps recording if a later hook replaces it', () => {
    const seen: string[] = [];
    const before = (_el: unknown, props: { path?: string }) => seen.push(`before:${props.path}`);
    const screenshot = fakeScreenshot(before);
    const recorded: string[] = [];
    chainScreenshotDefaults(screenshot, (props) => {
      if (props.path) recorded.push(props.path);
    });

    screenshot.defaults({}).onAfterScreenshot?.(null, { path: '/first.png' });
    const after = (_el: unknown, props: { path?: string }) => seen.push(`after:${props.path}`);
    screenshot.defaults({ onAfterScreenshot: after });
    screenshot.defaults({}).onAfterScreenshot?.(null, { path: '/second.png' });

    expect(recorded).toEqual(['/first.png', '/second.png']);
    expect(seen).toEqual(['before:/first.png', 'after:/second.png']);
    expect(() => screenshot.defaults()).toThrow(/must be called with an object/);
  });
});

describe('shouldFlushAfter', () => {
  it('sends an after() screenshot that logged no command', () => {
    expect(shouldFlushAfter('spec::title', 0, 1)).toBe(true);
    expect(shouldFlushAfter('spec::title', 0, 0)).toBe(false);
    expect(shouldFlushAfter('', 1, 1)).toBe(false);
  });
});
