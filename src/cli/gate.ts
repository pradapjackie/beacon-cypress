import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Quality gate (Allure 3 concept): evaluate a generated report against
 * thresholds and exit non-zero so CI can fail the build.
 */

export interface GateOptions {
  maxFailed?: number;
  maxFlaky?: number;
  /** Percent, counting flaky as passing. */
  minPassRate?: number;
}

export interface GateResult {
  ok: boolean;
  violations: string[];
  counts: { total: number; expected: number; unexpected: number; flaky: number; skipped: number };
}

export async function gate(reportDir: string, options: GateOptions): Promise<GateResult> {
  const manifestPath = path.join(reportDir, 'data', 'manifest.js');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No report found at ${reportDir}`);
    }
    throw error;
  }
  const manifest = JSON.parse(raw.slice(raw.indexOf(', ') + 2, raw.lastIndexOf(');'))) as {
    counts: GateResult['counts'];
  };
  const { counts } = manifest;
  const passRate =
    counts.total === 0 ? 100 : ((counts.expected + counts.flaky) / counts.total) * 100;

  // No thresholds given = the strict default: any unexpected failure fails.
  const maxFailed =
    options.maxFailed ??
    (options.maxFlaky === undefined && options.minPassRate === undefined ? 0 : undefined);

  const violations: string[] = [];
  if (maxFailed !== undefined && counts.unexpected > maxFailed) {
    violations.push(`failed ${counts.unexpected} > max-failed ${maxFailed}`);
  }
  if (options.maxFlaky !== undefined && counts.flaky > options.maxFlaky) {
    violations.push(`flaky ${counts.flaky} > max-flaky ${options.maxFlaky}`);
  }
  if (options.minPassRate !== undefined && passRate < options.minPassRate) {
    violations.push(`pass rate ${passRate.toFixed(1)}% < min-pass-rate ${options.minPassRate}%`);
  }
  return { ok: violations.length === 0, violations, counts };
}
