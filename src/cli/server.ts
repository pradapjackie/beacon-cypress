import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

/**
 * Static server for generated reports.
 * - gzip for text assets (report data chunks compress ~85%)
 * - `Access-Control-Allow-Origin: *` so "open in trace.playwright.dev"
 *   link-outs can fetch trace files from this server (ROADMAP.md risk #5)
 */
export function serveReport(reportDir: string, port: number): http.Server {
  const root = path.resolve(reportDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));

    // Never serve outside the report directory.
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const stream = createReadStream(filePath);
    if (acceptsGzip && COMPRESSIBLE.has(ext)) {
      res.setHeader('Content-Encoding', 'gzip');
      pipeline(stream, createGzip(), res, () => {});
    } else {
      pipeline(stream, res, () => {});
    }
  });

  server.listen(port);
  return server;
}
