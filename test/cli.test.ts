import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const bin = path.resolve('bin/beacon-cypress.mjs');

function run(...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

describe('beacon-cypress open', () => {
  it('says when the report folder does not exist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const result = run('open', path.join(root, 'missing'));
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/report not found/i);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/ERR_|at Server/);
  });

  it('rejects a port that is not a number', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    await mkdir(path.join(root, 'beacon-report'));
    const result = run('open', path.join(root, 'beacon-report'), '--port', 'abc');
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--port must be a number/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/ERR_|at Server/);
  });
});
