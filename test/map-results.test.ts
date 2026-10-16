import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandKey, toBeaconFixture } from '../src/map-results';
import { writeBeaconReport } from '../src/write-report';
import type { CypressCommandLineResults } from '../src/types';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function results(shot: string, video: string): CypressCommandLineResults {
  return {
    status: 'finished',
    startedTestsAt: '2026-10-16T12:00:00.000Z',
    browserName: 'chrome',
    browserVersion: '130.0',
    osName: 'darwin',
    osVersion: '25.0',
    cypressVersion: '13.15.0',
    runs: [
      {
        spec: { relative: 'cypress/e2e/login.cy.js' },
        video,
        screenshots: [
          { path: shot, name: 'login.cy.js -- Login -- signs in (failed).png' },
        ],
        tests: [
          {
            title: ['Login', 'signs in'],
            state: 'failed',
            displayError: 'expected 1 to equal 2',
            attempts: [
              {
                state: 'failed',
                error: { message: 'expected 1 to equal 2', stack: 'at Context.signs in' },
                wallClockStartedAt: '2026-10-16T12:00:01.000Z',
                wallClockDuration: 40,
              },
            ],
          },
          {
            title: ['Login', '@smoke retries'],
            state: 'passed',
            attempts: [
              {
                state: 'failed',
                error: { message: 'timed out' },
                wallClockStartedAt: '2026-10-16T12:00:02.000Z',
                wallClockDuration: 20,
              },
              {
                state: 'passed',
                wallClockStartedAt: '2026-10-16T12:00:03.000Z',
                wallClockDuration: 15,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('toBeaconFixture', () => {
  it('maps retries, screenshots, video, and the command log', () => {
    const commands = new Map([
      [
        commandKey('cypress/e2e/login.cy.js', ['Login', 'signs in']),
        [{ name: 'get', message: '#email', state: 'passed' }],
      ],
    ]);
    const fixture = toBeaconFixture(results('/tmp/shot.png', '/tmp/run.mp4'), commands);
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    expect(tests).toHaveLength(3);

    const failed = tests[0];
    if (failed?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(failed.test.outcome).toBe('unexpected');
    expect(failed.test.projectName).toBe('chrome');
    expect(failed.result.errors[0]?.message).toBe('expected 1 to equal 2');
    expect(failed.result.attachments.map((attachment) => attachment.contentType)).toEqual([
      'image/png',
      'video/mp4',
    ]);
    expect(failed.result.steps[0]?.title).toBe('get #email');

    const retry = tests[1];
    const passed = tests[2];
    if (retry?.type !== 'onTestEnd' || passed?.type !== 'onTestEnd') throw new Error('expected attempts');
    expect(retry.test.outcome).toBe('flaky');
    expect(passed.test.outcome).toBe('flaky');
    expect(passed.test.tags).toEqual(['@smoke']);
    expect(passed.result.attachments).toEqual([]);
  });

  it('uses test duration when Cypress omits attempt timings', () => {
    const started = Date.parse('2026-10-16T12:00:00.000Z');
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        startedTestsAt: '2026-10-16T12:00:00.000Z',
        runs: [
          {
            spec: { relative: 'cypress/e2e/smoke.cy.js' },
            stats: { startedAt: '2026-10-16T12:00:00.000Z', duration: 4300 },
            tests: [
              { title: ['beacon', 'passes'], state: 'passed', duration: 65, attempts: [{ state: 'passed' }] },
              { title: ['beacon', 'fails'], state: 'failed', duration: 4235, attempts: [{ state: 'failed' }] },
            ],
          },
        ],
      },
      new Map(),
    );
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    if (tests[0]?.type !== 'onTestEnd' || tests[1]?.type !== 'onTestEnd') throw new Error('expected tests');
    expect(tests[0].result).toMatchObject({ startTime: started, duration: 65 });
    expect(tests[1].result).toMatchObject({ startTime: started + 65, duration: 4235 });
  });

  it('does not give a shorter title the longer test’s screenshot', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [
              { path: '/tmp/twice.png', name: 'checkout.cy.js -- Cart -- applies coupon twice (failed).png' },
              { path: '/tmp/once.png', name: 'checkout.cy.js -- Cart -- applies coupon (failed).png' },
            ],
            tests: [
              { title: ['Cart', 'applies coupon'], state: 'failed', attempts: [{ state: 'failed' }] },
              { title: ['Cart', 'applies coupon twice'], state: 'failed', attempts: [{ state: 'failed' }] },
            ],
          },
        ],
      },
      new Map(),
    );
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    const paths = tests.map((event) =>
      event.type === 'onTestEnd' ? event.result.attachments.map((attachment) => attachment.path) : [],
    );
    expect(paths).toEqual([['/tmp/once.png'], ['/tmp/twice.png']]);
  });

  it('keeps each retry’s screenshot and commands on that attempt', () => {
    const key = commandKey('cypress/e2e/checkout.cy.js', ['Cart', 'applies coupon']);
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [
              { path: '/tmp/a1.png', name: 'checkout.cy.js -- Cart -- applies coupon (failed).png' },
              { path: '/tmp/a2.png', name: 'checkout.cy.js -- Cart -- applies coupon (failed) (attempt 2).png' },
              { path: '/tmp/a3.png', name: 'checkout.cy.js -- Cart -- applies coupon (failed) (attempt 3).png' },
              { path: '/tmp/manual.png', name: 'checkout.cy.js -- Cart -- applies coupon -- coupon form.png' },
            ],
            tests: [
              {
                title: ['Cart', 'applies coupon'],
                state: 'failed',
                displayError: 'final failure',
                attempts: [{ state: 'failed' }, { state: 'failed' }, { state: 'failed' }],
              },
            ],
          },
        ],
      },
      new Map([
        [
          key,
          [
            [
              { name: 'get', message: '#coupon', state: 'failed', startedAt: 1000 },
              { name: 'assert', message: 'visible', state: 'failed', startedAt: 1400 },
            ],
            [{ name: 'get', message: '#coupon', state: 'failed', startedAt: 2000 }],
            [{ name: 'get', message: '#coupon', state: 'passed', startedAt: 3000 }],
          ],
        ],
      ]),
    );
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    expect(tests.map((event) => (event.type === 'onTestEnd' ? event.result.attachments.map((a) => a.path) : []))).toEqual([
      ['/tmp/a1.png'],
      ['/tmp/a2.png'],
      ['/tmp/a3.png', '/tmp/manual.png'],
    ]);
    if (tests[0]?.type !== 'onTestEnd' || tests[1]?.type !== 'onTestEnd') throw new Error('expected attempts');
    expect(tests[0].result.errors[0]?.message).toBe('get #coupon');
    expect(tests[0].result.steps[0]).toMatchObject({ title: 'get #coupon', duration: 400 });
    expect(tests[1].result.steps).toHaveLength(1);
    expect(tests[1].result.errors[0]?.message).toBe('get #coupon');
  });

  it('does not reuse another spec’s command log for the same title', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/b.cy.js' },
            tests: [{ title: ['signs in'], state: 'passed', attempts: [{ state: 'passed' }] }],
          },
        ],
      },
      new Map([
        [commandKey('cypress/e2e/a.cy.js', ['signs in']), [{ name: 'get', message: '#email', state: 'passed' }]],
      ]),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.result.steps).toEqual([]);
  });

  it('attaches a named screenshot from a passing test', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [{ path: '/tmp/named.png', name: 'checkout.cy.js -- Cart -- pays -- receipt.png' }],
            tests: [{ title: ['Cart', 'pays'], state: 'passed', attempts: [{ state: 'passed' }] }],
          },
        ],
      },
      new Map(),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.result.attachments.map((attachment) => attachment.path)).toEqual(['/tmp/named.png']);
  });

  it('keeps both tests when two titles in one spec are the same', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/generated.cy.js' },
            tests: [
              { title: ['same'], state: 'passed', attempts: [{ state: 'passed' }] },
              { title: ['same'], state: 'failed', displayError: 'second failed', attempts: [{ state: 'failed' }] },
            ],
          },
        ],
      },
      new Map([
        [commandKey('cypress/e2e/generated.cy.js', ['same']), [{ name: 'get', message: '#a', state: 'passed' }]],
        [commandKey('cypress/e2e/generated.cy.js', ['same'], 1), [{ name: 'get', message: '#b', state: 'failed' }]],
      ]),
    );
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    expect(tests.map((event) => (event.type === 'onTestEnd' ? event.test.title : ''))).toEqual(['same', 'same (2)']);
    expect(tests.map((event) => (event.type === 'onTestEnd' ? event.test.outcome : ''))).toEqual([
      'expected',
      'unexpected',
    ]);
    expect(tests.map((event) => (event.type === 'onTestEnd' ? event.result.steps[0]?.title : ''))).toEqual([
      'get #a',
      'get #b',
    ]);
    expect(fixture.events.at(-1)).toMatchObject({ type: 'onEnd', status: 'failed' });
  });

  it('turns a spec that crashed before any test into a failure', () => {
    const fixture = toBeaconFixture(
      {
        status: 'failed',
        runs: [{ spec: { relative: 'cypress/e2e/broken.cy.js' }, error: 'Cannot find module "./missing"', tests: [] }],
      },
      new Map(),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.test.title).toBe('failed to load');
    expect(test.result.errors[0]?.message).toBe('Cannot find module "./missing"');
    expect(fixture.events.at(-1)).toMatchObject({ type: 'onEnd', status: 'failed' });
  });

  it('matches screenshots whose titles lost filename characters', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [
              { path: '/tmp/odd.png', name: 'checkout.cy.js -- Cart -- says helloworld (failed).png' },
            ],
            tests: [{ title: ['Cart', 'says: hello/world'], state: 'failed', attempts: [{ state: 'failed' }] }],
          },
        ],
      },
      new Map(),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.result.attachments.map((attachment) => attachment.path)).toEqual(['/tmp/odd.png']);
  });

  it('matches a screenshot whose filename was truncated', () => {
    const leaf = 'x'.repeat(300);
    const full = `Cart -- ${leaf} (failed)`;
    const name = `${Buffer.from(full).subarray(0, 250).toString('utf8')}.png`;
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [{ path: '/tmp/long.png', name }],
            tests: [{ title: ['Cart', leaf], state: 'failed', attempts: [{ state: 'failed' }] }],
          },
        ],
      },
      new Map(),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.result.attachments.map((attachment) => attachment.path)).toEqual(['/tmp/long.png']);
  });

  it('does not treat an email address as a tag', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/login.cy.js' },
            tests: [
              {
                title: ['logs in as user@example.com @smoke'],
                state: 'passed',
                attempts: [{ state: 'passed' }],
                tags: ['regression'],
              },
            ],
          },
        ],
      },
      new Map(),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.test.tags).toEqual(['@smoke', '@regression']);
  });

  it('redacts secrets in command steps and clips huge messages', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/login.cy.js' },
            tests: [{ title: ['signs in'], state: 'passed', attempts: [{ state: 'passed' }] }],
          },
        ],
      },
      new Map([
        [
          commandKey('cypress/e2e/login.cy.js', ['signs in']),
          [
            { name: 'type', message: 'SuperSecretP@ss1', state: 'passed' },
            { name: 'request', message: 'y'.repeat(5_000), state: 'passed' },
          ],
        ],
      ]),
      (text) => text.replace(/SuperSecretP@ss1/g, '[redacted]'),
    );
    const test = fixture.events.find((event) => event.type === 'onTestEnd');
    if (test?.type !== 'onTestEnd') throw new Error('expected a test');
    expect(test.result.steps[0]?.title).toBe('type [redacted]');
    expect(test.result.steps[1]?.title.length).toBe(4_001);
  });

  it('puts the spec video on the first test that ran, not a leading skip', () => {
    const fixture = toBeaconFixture(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/smoke.cy.js' },
            video: '/tmp/run.mp4',
            tests: [
              { title: ['skipped'], state: 'skipped', attempts: [{ state: 'skipped' }] },
              { title: ['passes'], state: 'passed', attempts: [{ state: 'passed' }] },
            ],
          },
        ],
      },
      new Map(),
    );
    const tests = fixture.events.filter((event) => event.type === 'onTestEnd');
    expect(tests.map((event) => (event.type === 'onTestEnd' ? event.result.attachments.length : 0))).toEqual([0, 1]);
  });
});

describe('writeBeaconReport', () => {
  it('writes a Beacon report a Cypress run can open', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const shot = path.join(root, 'shot.png');
    const video = path.join(root, 'run.mp4');
    await writeFile(shot, PNG);
    await writeFile(video, Buffer.from('not-a-real-video'));

    const written = await writeBeaconReport(results(shot, video), new Map(), root, {
      history: false,
      title: 'Cypress demo',
    });

    expect(written.tests).toBe(2);
    const raw = await readFile(path.join(written.outputDir, 'data', 'manifest.js'), 'utf8');
    const manifest = JSON.parse(raw.slice(raw.indexOf(', ') + 2, raw.lastIndexOf(');'))) as {
      counts: { total: number; unexpected: number; flaky: number };
      ui?: { title?: string };
      environment?: Record<string, string>;
    };
    expect(manifest.counts).toMatchObject({ total: 2, unexpected: 1, flaky: 1 });
    expect(manifest.ui?.title).toBe('Cypress demo');
    expect(manifest.environment?.cypress).toBe('13.15.0');
    expect(manifest.environment?.browser).toBe('chrome');
  });

  it('still writes a report when scrub is not an array, and drops stale attachments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const first = path.join(root, 'first.png');
    const second = path.join(root, 'second.png');
    await writeFile(first, PNG);
    await writeFile(second, Buffer.from('different-png'));
    const output = { history: false as const, outputFolder: 'report' };
    const run = (shot: string) =>
      writeBeaconReport(
        {
          status: 'finished',
          runs: [
            {
              spec: { relative: 'cypress/e2e/a.cy.js' },
              screenshots: [{ path: shot, name: 'a.cy.js -- keeps one (failed).png' }],
              tests: [{ title: ['keeps one'], state: 'failed', attempts: [{ state: 'failed' }] }],
            },
          ],
        },
        new Map(),
        root,
        output,
      );
    await run(first);
    const before = await readdir(path.join(root, 'report', 'attachments'));
    await writeBeaconReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/a.cy.js' },
            screenshots: [{ path: second, name: 'a.cy.js -- keeps one (failed).png' }],
            tests: [{ title: ['keeps one'], state: 'failed', attempts: [{ state: 'failed' }] }],
          },
        ],
      },
      new Map(),
      root,
      { ...output, scrub: { pattern: 'secret' } as never },
    );
    const after = await readdir(path.join(root, 'report', 'attachments'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((file) => before.includes(file))).toBe(false);
  });
});
