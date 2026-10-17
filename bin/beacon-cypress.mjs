#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'open') {
  console.log('Usage: beacon-cypress open [report-directory] [--port 4173]');
  process.exit(args.length ? 1 : 0);
}

let dir = 'beacon-report';
let port = 4173;
for (let index = 1; index < args.length; index += 1) {
  if (args[index] === '--port') {
    port = Number(args[index + 1]);
    index += 1;
  } else if (args[index]) {
    dir = args[index];
  }
}

const root = path.resolve(dir);
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

listen(port);
