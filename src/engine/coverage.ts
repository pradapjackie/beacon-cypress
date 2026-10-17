import { readFile } from 'node:fs/promises';
import type { Manifest } from './schema';

/**
 * Ingests an istanbul/nyc `coverage-summary.json` (what jest --coverage, nyc,
 * and most v8-to-istanbul pipelines emit): a `total` entry plus one entry per
 * file, each with lines/statements/functions/branches `{ total, covered, pct }`.
 */

interface SummaryEntry {
  lines?: { pct?: number };
  statements?: { pct?: number };
  functions?: { pct?: number };
  branches?: { pct?: number };
}

const WORST_FILES = 10;

export async function readCoverageSummary(
  file: string,
): Promise<Manifest['aggregates']['coverage']> {
  let parsed: Record<string, SummaryEntry>;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, SummaryEntry>;
  } catch (error) {
    console.warn(
      `[beacon] coverage summary not readable — skipped (${file}): ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
  const total = parsed.total;
  if (!total?.lines || typeof total.lines.pct !== 'number') {
    console.warn(`[beacon] ${file} is not an istanbul coverage-summary.json — skipped`);
    return undefined;
  }
  const pct = (entry: { pct?: number } | undefined): number =>
    typeof entry?.pct === 'number' ? Math.round(entry.pct * 10) / 10 : 0;

  const files = Object.entries(parsed)
    .filter(([name]) => name !== 'total')
    .map(([name, entry]) => ({ name: shortName(name), lines: pct(entry.lines) }))
    .sort((a, b) => a.lines - b.lines)
    .slice(0, WORST_FILES);

  return {
    lines: pct(total.lines),
    statements: pct(total.statements),
    functions: pct(total.functions),
    branches: pct(total.branches),
    files,
  };
}

/** Coverage summaries use absolute paths — keep the tail that identifies the file. */
function shortName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts.slice(-3).join('/');
}
