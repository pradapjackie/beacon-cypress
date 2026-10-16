import { describe, expect, it } from 'vitest';
import { collectorEnabled, commandFromLog } from '../src/support';

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
