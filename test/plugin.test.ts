import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { beaconCypress, storeCommands } from '../src/plugin';

describe('storeCommands', () => {
  it('keeps the command list from each attempt', () => {
    const commands = new Map();
    storeCommands(commands, {
      key: 'spec::title',
      attempt: 0,
      commands: [{ name: 'get', message: '#coupon', state: 'failed' }],
    });
    storeCommands(commands, {
      key: 'spec::title',
      attempt: 1,
      commands: [{ name: 'get', message: '#coupon', state: 'passed' }],
    });
    expect(commands.get('spec::title')).toEqual([
      [{ name: 'get', message: '#coupon', state: 'failed' }],
      [{ name: 'get', message: '#coupon', state: 'passed' }],
    ]);
  });

  it('appends after-hook commands onto the attempt', () => {
    const commands = new Map();
    storeCommands(commands, {
      key: 'spec::title',
      attempt: 0,
      commands: [{ name: 'get', message: '#coupon', state: 'passed' }],
    });
    storeCommands(commands, {
      key: 'spec::title',
      attempt: 0,
      append: true,
      commands: [{ name: 'log', message: 'after', state: 'passed' }],
    });
    expect(commands.get('spec::title')).toEqual([
      [
        { name: 'get', message: '#coupon', state: 'passed' },
        { name: 'log', message: 'after', state: 'passed' },
      ],
    ]);
  });

  it('fills earlier attempts instead of leaving a hole', () => {
    const commands = new Map();
    storeCommands(commands, {
      key: 'spec::title',
      attempt: 1,
      commands: [{ name: 'get', message: '#coupon', state: 'passed' }],
    });
    expect(commands.get('spec::title')).toEqual([[], [{ name: 'get', message: '#coupon', state: 'passed' }]]);
  });

  it('runs a later after:run handler and sets the collector flag', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    let registered: ((results: unknown) => Promise<void> | void) | undefined;
    const on = (event: string, arg?: unknown) => {
      if (event === 'after:run' && typeof arg === 'function') {
        registered = arg as (results: unknown) => Promise<void> | void;
      }
    };
    let followed = false;
    const config = { projectRoot: root, env: {} as Record<string, unknown> };
    const next = beaconCypress({ history: false, outputFolder: 'report' }).chain(on, config);
    next('after:run', () => {
      followed = true;
    });
    await registered?.({ status: 'finished', runs: [] });
    expect(followed).toBe(true);
    expect(config.env.BEACON_COLLECTOR).toBe(true);
  });
});
