#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'open') {
  try {
    await import('../dist/cli.js');
  } catch (error) {
    console.error(
      `beacon-cypress: ${args[0] ?? 'help'} needs a build of this package. Run npm run build in beacon-cypress and try again.`,
    );
    if (error instanceof Error && error.message) console.error(error.message);
    process.exit(1);
  }
  process.exit(0);
}

let dir = 'beacon-report';
let port = 4173;
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--port') {
    const parsed = parsePort(args[index + 1]);
    if (parsed == null) {
      console.error('beacon-cypress: --port must be a number from 1 to 65535.');
      process.exit(1);
    }
    port = parsed;
    index += 1;
  } else if (args[index]) {
    dir = args[index];
  }
}

const root = path.resolve(dir);
try {
  const info = await stat(root);
  if (!info.isDirectory()) {
    console.error(`beacon-cypress: report not found at ${root}`);
    process.exit(1);
  }
} catch {
  console.error(`beacon-cypress: report not found at ${root}`);
  process.exit(1);
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function listen(nextPort) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      const body = await readFile(file);
      const type = types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') listen(nextPort + 1);
    else throw error;
  });
  server.listen(nextPort, '127.0.0.1', () => {
    console.log(`Beacon report: http://127.0.0.1:${nextPort}`);
  });
}

function parsePort(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (port < 1 || port > 65535) return null;
  return port;
}

listen(port);
