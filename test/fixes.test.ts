import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { serveReport } from '../src/cli/server';
import { summarize } from '../src/cli/summarize';
import { convert } from '../src/cli/convert';
import { quarantineCandidates, toFixmeSuggestions, toGrepInvert } from '../src/cli/quarantine';
import { exportSingleFile } from '../src/cli/export';
import { diffReports } from '../src/cli/diff';
import { unknownOption } from '../src/cli/flags';
import { updateHistory } from '../src/engine/history';
import { SCHEMA_VERSION, type TestDetail } from '../src/engine/schema';
import { annotationsIn } from '../src/to-details';
import { toCypressReport } from '../src/map-results';

describe('annotations', () => {
  it('matches owner, severity, and the other markers inside titles and tags', () => {
    expect(annotationsIn(['pays owner:alice'])).toEqual([{ type: 'owner', description: 'alice' }]);
    expect(annotationsIn(['@owner:alice'])).toEqual([{ type: 'owner', description: 'alice' }]);
    expect(annotationsIn(['owner: alice'])).toEqual([{ type: 'owner', description: 'alice' }]);
    expect(annotationsIn(['severity=high', 'budget: 50ms'])).toEqual([
      { type: 'severity', description: 'high' },
      { type: 'budget', description: '50ms' },
    ]);
  });

  it('keeps the value on an @owner tag', () => {
    const report = toCypressReport(
      {
        status: 'finished',
        runs: [
          {
            spec: { relative: 'a.cy.js' },
            tests: [
              { title: ['pays @owner:alice'], state: 'passed', attempts: [{ state: 'passed' }] },
              { title: ['tagged'], state: 'passed', tags: ['owner: alice'], attempts: [{ state: 'passed' }] },
            ],
          },
        ],
      },
      new Map(),
    );
    expect(report.tests[0]?.tags).toEqual(['@owner:alice']);
    expect(report.tests[1]?.tags).toEqual(['@owner: alice']);
  });
});

describe('report commands on an empty folder', () => {
  it('says that no report was found', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const missing = /No report found at /;
    await expect(summarize(root)).rejects.toThrow(missing);
    await expect(convert(root, 'ctrf', path.join(root, 'out.json'))).rejects.toThrow(missing);
    await expect(exportSingleFile(root, path.join(root, 'out.html'))).rejects.toThrow(missing);
    await expect(quarantineCandidates(root)).rejects.toThrow(missing);
    await expect(diffReports(root, root)).rejects.toThrow(missing);
  });
});

describe('quarantine output', () => {
  it('prints a Cypress skip and a grep list', () => {
    const candidates = [
      { caseId: 'a', title: 'pays', projectName: 'chrome', failures: 2, runs: 4, file: 'cypress/e2e/ui.cy.js', line: 0 },
      { caseId: 'b', title: 'other', projectName: 'chrome', failures: 1, runs: 4, file: 'cypress/e2e/ui.cy.js', line: 0 },
    ];
    expect(toGrepInvert(candidates)).toBe('-pays;-other');
    expect(toFixmeSuggestions(candidates)).toContain('it.skip();');
    expect(toFixmeSuggestions(candidates)).not.toContain('test.fixme');
    expect(toFixmeSuggestions(candidates)).not.toContain(':0');
    expect(unknownOption(['beacon-report', '--max-failures'])).toBe('--max-failures');
  });
});

describe('history', () => {
  it('does not call a retried pass a failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const dir = path.join(root, 'history');
    await mkdir(path.join(dir, 'runs'), { recursive: true });
    await writeFile(
      path.join(dir, 'runs', 'old.json'),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        runId: 'old',
        startTime: 1,
        duration: 1,
        counts: { total: 1, expected: 0, unexpected: 0, flaky: 1, skipped: 0 },
        cases: { abc: [2, 10, 1] },
      }),
    );
    const detail = {
      caseId: 'abc',
      title: 'retries',
      projectName: 'chrome',
      outcome: 'flaky',
      results: [{ duration: 10 }],
    } as TestDetail;
    const history = await updateHistory(
      [detail],
      { startTime: 2, duration: 1, counts: { total: 1, expected: 0, unexpected: 0, flaky: 1, skipped: 0 } },
      { dir, retain: 10 },
    );
    expect(history.data.mostFailing).toEqual([]);
  });
});

describe('open server', () => {
  it('serves beacon.html when index.html is not the report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    await writeFile(path.join(root, 'index.html'), '<h1>user site</h1>');
    await writeFile(path.join(root, 'beacon.html'), '<html>beacon-cypress-report</html>');
    const server = serveReport(root, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const page = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      expect(page).toContain('beacon-cypress-report');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('built CLI', () => {
  const bin = path.resolve('bin/beacon-cypress.mjs');

  it('rejects gate --max-failures and does not offer --pdf', () => {
    const gate = spawnSync(process.execPath, [bin, 'gate', '--max-failures', '0'], { encoding: 'utf8' });
    expect(gate.status).toBe(1);
    expect(`${gate.stdout}${gate.stderr}`).toMatch(/Unknown option --max-failures/);
    expect(`${gate.stdout}${gate.stderr}`).not.toMatch(/manifest\.js/);
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    expect(help.stdout).not.toContain('--pdf');
  });

  it('names the CTRF tool beacon-cypress and omits the placeholder line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const { writeBeaconReport } = await import('../src/write-report');
    const written = await writeBeaconReport(
      {
        status: 'finished',
        browserName: 'chrome',
        runs: [
          {
            spec: { relative: 'cypress/e2e/ui.cy.js' },
            tests: [
              {
                title: ['pays'],
                state: 'failed',
                displayError: 'expected 1 to equal 2',
                attempts: [{ state: 'failed' }],
              },
            ],
          },
        ],
      },
      new Map(),
      root,
      { history: false, outputFolder: 'report' },
    );
    const summary = await summarize(written.outputDir);
    expect(summary).toContain('cypress/e2e/ui.cy.js');
    expect(summary).not.toMatch(/ui\.cy\.js:\d/);
    const out = path.join(root, 'ctrf.json');
    await convert(written.outputDir, 'ctrf', out);
    const ctrf = JSON.parse(await readFile(out, 'utf8')) as { results: { tool: { name: string } } };
    expect(ctrf.results.tool.name).toBe('beacon-cypress');
    const csv = path.join(root, 'results.csv');
    await convert(written.outputDir, 'csv', csv);
    const header = (await readFile(csv, 'utf8')).split('\n');
    const lineColumn = header[0]?.split(',').indexOf('line') ?? -1;
    expect(header[1]?.split(',')[lineColumn]).toBe('');
  });
});
