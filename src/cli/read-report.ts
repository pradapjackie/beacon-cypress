import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Reads `data/manifest.js`, or throws a one-line error when the folder is not a report. */
export async function readManifest(reportDir: string): Promise<string> {
  try {
    return await readFile(path.join(reportDir, 'data', 'manifest.js'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No report found at ${reportDir}`);
    }
    throw error;
  }
}
