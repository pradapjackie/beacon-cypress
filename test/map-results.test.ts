import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandKey, toCypressReport, type CypressReportData } from '../src/map-results';
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

function rows(report: CypressReportData) {
  return report.tests.flatMap((test) => test.attempts.map((attempt) => ({ test, attempt })));
}

describe('toCypressReport', () => {
  it('maps retries, screenshots, video, and the command log', () => {
    const commands = new Map([
      [
        commandKey('cypress/e2e/login.cy.js', ['Login', 'signs in']),
        [{ name: 'get', message: '#email', state: 'passed' }],
      ],
    ]);
    const report = toCypressReport(results('/tmp/shot.png', '/tmp/run.mp4'), commands);
    const listed = rows(report);
    expect(listed).toHaveLength(3);

    expect(listed[0]?.test.outcome).toBe('failed');
    expect(report.browser).toBe('chrome');
    expect(listed[0]?.attempt.error?.message).toBe('expected 1 to equal 2');
    expect(listed[0]?.attempt.screenshots.map((shot) => shot.path)).toEqual(['/tmp/shot.png']);
    expect(listed[0]?.attempt.video?.path).toBe('/tmp/run.mp4');
    expect(listed[0]?.attempt.commands[0]?.title).toBe('get #email');

    expect(listed[1]?.test.outcome).toBe('flaky');
    expect(listed[2]?.test.outcome).toBe('flaky');
    expect(listed[2]?.test.tags).toEqual(['@smoke']);
    expect(listed[2]?.attempt.screenshots).toEqual([]);
    expect(listed[2]?.attempt.video).toBeUndefined();
  });

  it('uses test duration when Cypress omits attempt timings', () => {
    const started = Date.parse('2026-10-16T12:00:00.000Z');
    const report = toCypressReport(
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
    const listed = rows(report);
    expect(listed[0]?.attempt).toMatchObject({ startTime: started, duration: 65 });
    expect(listed[1]?.attempt).toMatchObject({ startTime: started + 65, duration: 4235 });
  });

  it('does not give a shorter title the longer test’s screenshot', () => {
    const report = toCypressReport(
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
    expect(report.tests.map((test) => test.attempts[0]?.screenshots.map((shot) => shot.path))).toEqual([
      ['/tmp/once.png'],
      ['/tmp/twice.png'],
    ]);
  });

  it('keeps each retry’s screenshot and commands on that attempt', () => {
    const key = commandKey('cypress/e2e/checkout.cy.js', ['Cart', 'applies coupon']);
    const report = toCypressReport(
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
    const listed = rows(report);
    expect(listed.map((row) => row.attempt.screenshots.map((shot) => shot.path))).toEqual([
      ['/tmp/a1.png'],
      ['/tmp/a2.png'],
      ['/tmp/a3.png', '/tmp/manual.png'],
    ]);
    expect(listed[0]?.attempt.error?.message).toBe('get #coupon');
    expect(listed[0]?.attempt.commands[0]).toMatchObject({ title: 'get #coupon', duration: 400 });
    expect(listed[1]?.attempt.commands).toHaveLength(1);
    expect(listed[1]?.attempt.error?.message).toBe('get #coupon');
  });

  it('does not reuse another spec’s command log for the same title', () => {
    const report = toCypressReport(
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
    expect(report.tests[0]?.attempts[0]?.commands).toEqual([]);
  });

  it('attaches a named screenshot from a passing test', () => {
    const report = toCypressReport(
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
    expect(report.tests[0]?.attempts[0]?.screenshots.map((shot) => shot.path)).toEqual(['/tmp/named.png']);
  });

  it('keeps both tests when two titles in one spec are the same', () => {
    const report = toCypressReport(
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
    expect(report.tests.map((test) => test.title)).toEqual(['same', 'same (2)']);
    expect(report.tests.map((test) => test.outcome)).toEqual(['passed', 'failed']);
    expect(report.tests.map((test) => test.attempts[0]?.commands[0]?.title)).toEqual(['get #a', 'get #b']);
    expect(report.status).toBe('failed');
  });

  it('turns a spec that crashed before any test into a failure', () => {
    const report = toCypressReport(
      {
        status: 'failed',
        runs: [{ spec: { relative: 'cypress/e2e/broken.cy.js' }, error: 'Cannot find module "./missing"', tests: [] }],
      },
      new Map(),
    );
    expect(report.tests[0]?.title).toBe('failed to load');
    expect(report.tests[0]?.attempts[0]?.error?.message).toBe('Cannot find module "./missing"');
    expect(report.status).toBe('failed');
  });

  it('matches screenshots whose titles lost filename characters', () => {
    const report = toCypressReport(
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
    expect(report.tests[0]?.attempts[0]?.screenshots.map((shot) => shot.path)).toEqual(['/tmp/odd.png']);
  });

  it('matches a screenshot whose filename was truncated', () => {
    const leaf = 'x'.repeat(300);
    const full = `Cart -- ${leaf} (failed)`;
    const name = `${Buffer.from(full).subarray(0, 250).toString('utf8')}.png`;
    const report = toCypressReport(
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
    expect(report.tests[0]?.attempts[0]?.screenshots.map((shot) => shot.path)).toEqual(['/tmp/long.png']);
  });

  it('does not treat an email address as a tag', () => {
    const report = toCypressReport(
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
    expect(report.tests[0]?.tags).toEqual(['@smoke', '@regression']);
  });

  it('redacts secrets in command steps and clips huge messages', () => {
    const report = toCypressReport(
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
    expect(report.tests[0]?.attempts[0]?.commands[0]?.title).toBe('type [redacted]');
    expect(report.tests[0]?.attempts[0]?.commands[1]?.title.length).toBe(4_001);
  });

  it('puts the spec video on the first test that ran, not a leading skip', () => {
    const report = toCypressReport(
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
    expect(report.tests.map((test) => (test.attempts[0]?.video ? 1 : 0))).toEqual([0, 1]);
  });

  it('keeps both attempts of a retried test when they share a key', () => {
    const key = commandKey('cypress/e2e/a.cy.js', ['S', 'flaky']);
    const report = toCypressReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/a.cy.js' },
            tests: [
              {
                title: ['S', 'flaky'],
                state: 'passed',
                attempts: [{ state: 'failed' }, { state: 'passed' }],
              },
            ],
          },
        ],
      },
      new Map([
        [
          key,
          [
            [{ name: 'get', message: '#coupon', state: 'failed' }],
            [{ name: 'get', message: '#coupon', state: 'passed' }],
          ],
        ],
      ]),
    );
    expect(rows(report).map((row) => row.attempt.commands[0]?.title)).toEqual(['get #coupon', 'get #coupon']);
  });

  it('does not throw when a command list is a sparse attempt array', () => {
    const sparse: Array<Array<{ name: string; message: string; state: string }> | undefined> = [];
    sparse[1] = [{ name: 'get', message: '#b', state: 'passed' }];
    const report = toCypressReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/a.cy.js' },
            tests: [
              { title: ['same'], state: 'passed', attempts: [{ state: 'passed' }] },
              { title: ['same'], state: 'passed', attempts: [{ state: 'passed' }] },
            ],
          },
        ],
      },
      new Map([[commandKey('cypress/e2e/a.cy.js', ['same'], 1), sparse as never]]),
    );
    expect(report.tests).toHaveLength(2);
    expect(report.tests[1]?.attempts[0]?.commands).toEqual([]);
  });

  it('says when an earlier attempt has no command log', () => {
    const report = toCypressReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/a.cy.js' },
            tests: [
              {
                title: ['flaky'],
                state: 'passed',
                displayError: 'final failure text',
                attempts: [{ state: 'failed' }, { state: 'passed' }],
              },
            ],
          },
        ],
      },
      new Map(),
    );
    expect(report.tests[0]?.attempts[0]?.error?.message).toBe(
      'failed (details only recorded for the final attempt)',
    );
  });

  it('attaches a named screenshot recorded for that attempt', () => {
    const report = toCypressReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'cypress/e2e/checkout.cy.js' },
            screenshots: [{ path: '/tmp/checkout-page.png', name: 'checkout-page.png' }],
            tests: [{ title: ['Cart', 'pays'], state: 'passed', attempts: [{ state: 'passed' }] }],
          },
        ],
      },
      new Map(),
      (text) => text,
      new Map([
        [
          commandKey('cypress/e2e/checkout.cy.js', ['Cart', 'pays']),
          new Map([[0, [{ path: '/tmp/checkout-page.png', name: 'checkout-page' }]]]),
        ],
      ]),
    );
    expect(report.tests[0]?.attempts[0]?.screenshots.map((shot) => shot.path)).toEqual(['/tmp/checkout-page.png']);
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
    const report = JSON.parse(await readFile(path.join(written.outputDir, 'data', 'report.json'), 'utf8')) as {
      title: string;
      counts: { total: number; failed: number; flaky: number };
      environment?: Record<string, string>;
      tests: Array<{ title: string }>;
    };
    expect(report.counts).toMatchObject({ total: 2, failed: 1, flaky: 1 });
    expect(report.title).toBe('Cypress demo');
    expect(report.environment?.cypress).toBe('13.15.0');
    expect(report.environment?.browser).toBe('chrome');
    const html = await readFile(path.join(written.outputDir, 'index.html'), 'utf8');
    expect(html).toContain('--ground');
    expect(html).toContain('Cypress demo');
    expect(html).toContain('signs in');
    expect(html).toContain('attachments/');
    expect(html).not.toContain('playwright');
    expect(html).not.toContain('beacon-reporter');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).toContain('beacon-cypress-report');
    const saved = JSON.parse(await readFile(path.join(written.outputDir, 'data', 'report.json'), 'utf8')) as {
      history: Array<{ at: string }>;
    };
    expect(saved.history).toEqual([]);
  });

  it('stamps history with the Cypress run start', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const written = await writeBeaconReport(results(path.join(root, 'missing.png'), path.join(root, 'missing.mp4')), new Map(), root, {
      history: { dir: 'history' },
    });
    const report = JSON.parse(await readFile(path.join(written.outputDir, 'data', 'report.json'), 'utf8')) as {
      history: Array<{ at: string }>;
    };
    expect(report.history[0]?.at).toBe('2026-10-16T12:00:00.000Z');
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

  it('leaves an attachments folder alone until the directory is a Beacon report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const report = path.join(root, 'report');
    await mkdir(path.join(report, 'attachments'), { recursive: true });
    await writeFile(path.join(report, 'attachments', 'keep.txt'), 'mine');
    await writeBeaconReport(
      { status: 'finished', runs: [{ spec: { relative: 'a.cy.js' }, tests: [] }] },
      new Map(),
      root,
      { history: false, outputFolder: 'report' },
    );
    expect(await readFile(path.join(report, 'attachments', 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('does not replace a project index.html or delete its attachments when the report folder is the project root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    await writeFile(path.join(root, 'index.html'), '<h1>user site</h1>');
    await mkdir(path.join(root, 'attachments'), { recursive: true });
    await writeFile(path.join(root, 'attachments', 'keep.txt'), 'mine');
    const first = path.join(root, 'first.png');
    const second = path.join(root, 'second.png');
    await writeFile(first, PNG);
    await writeFile(second, Buffer.from('different-png'));
    const run = (shot: string) =>
      writeBeaconReport(
        {
          status: 'finished',
          startedTestsAt: '2026-10-16T12:00:00.000Z',
          runs: [
            {
              spec: { relative: 'a.cy.js' },
              screenshots: [{ path: shot, name: 'a.cy.js -- keeps one (failed).png' }],
              tests: [{ title: ['keeps one'], state: 'failed', attempts: [{ state: 'failed' }] }],
            },
          ],
        },
        new Map(),
        root,
        { history: false, outputFolder: '.' },
      );
    await run(first);
    await run(second);
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<h1>user site</h1>');
    expect(await readFile(path.join(root, 'attachments', 'keep.txt'), 'utf8')).toBe('mine');
    const page = await readFile(path.join(root, 'beacon.html'), 'utf8');
    expect(page).toContain('beacon-cypress-report');
    const names = await readdir(path.join(root, 'attachments'));
    expect(names.filter((name) => name.endsWith('.png'))).toHaveLength(1);
    expect(names).toContain('keep.txt');
  });
});
