import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
});
