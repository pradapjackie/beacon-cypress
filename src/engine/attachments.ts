import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AttachmentRef } from './schema';

/**
 * Content-addressed attachment store: attachments/<sha256>.<ext>.
 * Identical content (retry screenshots, shard duplicates) lands on the same
 * file. Path attachments are hash-copied in one streaming pass — never
 * buffered — because videos/traces can be huge. A missing source file becomes
 * a visible `omitted` stub, never a silent absence.
 */

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/html': 'html',
};

export interface RawAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

export class AttachmentStore {
  private dirReady: Promise<void> | undefined;
  private seq = 0;
  /** Dedupe accounting: `bytes` counts every attachment, deduped ones included. */
  readonly stats = { count: 0, unique: 0, bytes: 0, dedupedBytes: 0 };

  constructor(private readonly dir: string) {}

  private record(size: number, wasNew: boolean): void {
    this.stats.count += 1;
    this.stats.bytes += size;
    if (wasNew) this.stats.unique += 1;
    else this.stats.dedupedBytes += size;
  }

  private ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.dirReady;
  }

  async put(attachment: RawAttachment): Promise<AttachmentRef> {
    const ext = extensionFor(attachment);
    try {
      if (attachment.body !== undefined) {
        return await this.putBody(attachment, ext);
      }
      if (attachment.path !== undefined) {
        return await this.putFile(attachment, ext);
      }
    } catch {
      // Fall through to the omitted stub below.
    }
    return {
      name: attachment.name,
      contentType: attachment.contentType,
      ext,
      mode: 'omitted',
    };
  }

  private async putBody(attachment: RawAttachment, ext: string): Promise<AttachmentRef> {
    const body = attachment.body as Buffer;
    await this.ensureDir();
    const sha256 = createHash('sha256').update(body).digest('hex');
    const target = path.join(this.dir, `${sha256}.${ext}`);
    const isNew = !(await exists(target));
    if (isNew) {
      await writeFile(target, body);
    }
    this.record(body.length, isNew);
    return {
      name: attachment.name,
      contentType: attachment.contentType,
      sha256,
      ext,
      size: body.length,
      mode: 'stored',
    };
  }

  private async putFile(attachment: RawAttachment, ext: string): Promise<AttachmentRef> {
    const source = attachment.path as string;
    const size = (await stat(source)).size;
    await this.ensureDir();

    // One streaming pass: hash while copying to a temp file, then rename to
    // the content address (or drop the temp copy when it already exists).
    const hash = createHash('sha256');
    const tmp = path.join(this.dir, `.tmp-${process.pid}-${this.seq++}`);
    await pipeline(
      createReadStream(source),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk as Buffer);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    const sha256 = hash.digest('hex');
    const target = path.join(this.dir, `${sha256}.${ext}`);
    const isNew = !(await exists(target));
    if (isNew) {
      await rename(tmp, target);
    } else {
      await rm(tmp, { force: true });
    }
    this.record(size, isNew);
    return {
      name: attachment.name,
      contentType: attachment.contentType,
      sha256,
      ext,
      size,
      mode: 'stored',
    };
  }
}

function extensionFor(attachment: RawAttachment): string {
  if (attachment.path) {
    const fromPath = path.extname(attachment.path).slice(1).toLowerCase();
    if (fromPath) return fromPath;
  }
  return EXT_BY_CONTENT_TYPE[attachment.contentType.split(';')[0] ?? ''] ?? 'bin';
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
