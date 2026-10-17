import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

  it('rejects an unknown flag', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    const result = run('open', root, '--host', '0.0.0.0');
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown option --host/);
  });

  it('serves beacon.html when index.html belongs to the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beacon-cypress-'));
    await writeFile(path.join(root, 'index.html'), '<h1>user site</h1>');
    await writeFile(path.join(root, 'beacon.html'), '<html>beacon-cypress-report</html>');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [bin, 'open', root, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`server did not start: ${text}`)), 5000);
        child.stdout?.on('data', (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes('http://')) {
            clearTimeout(timer);
            resolve(text);
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited ${code}: ${text}`));
        });
      });
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      expect(url).toBeTruthy();
      const page = await fetch(`${url}/`).then((response) => response.text());
      expect(page).toContain('beacon-cypress-report');
      expect(page).not.toContain('user site');
    } finally {
      child.kill();
    }
  });
});
