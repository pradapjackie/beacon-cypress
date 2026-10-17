import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'vendor', 'ui');
const to = path.join(root, 'dist', 'ui');
await mkdir(path.dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
