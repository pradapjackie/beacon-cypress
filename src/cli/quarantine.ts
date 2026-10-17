import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Quarantine candidates are the same recency-weighted list the Flaky page
 * shows (score ≥ 40). Consistently failing tests never enter that list.
 */

interface FlakyEntry {
  caseId: string;
  title: string;
  projectName: string;
  score: number;
  flakyRuns: number;
  failedRuns: number;
  runs: number;
}

export interface QuarantineOptions {
  /** Minimum appearances before a test can qualify (default 3). */
  minRuns?: number;
  /** Score cutoff, matching the Flaky page (default 40). */
  minScore?: number;
}

export interface QuarantineCandidate {
  caseId: string;
  title: string;
  projectName: string;
  failures: number;
  runs: number;
  file?: string;
  line?: number;
}

export async function quarantineCandidates(
  reportDir: string,
  options: QuarantineOptions = {},
): Promise<QuarantineCandidate[]> {
  const minRuns = options.minRuns ?? 3;
  const minScore = options.minScore ?? 40;

  const manifestPath = path.join(reportDir, 'data', 'manifest.js');
  const rawManifest = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(
    rawManifest.slice(rawManifest.indexOf(', ') + 2, rawManifest.lastIndexOf(');')),
  ) as { aggregates?: { flakiness?: FlakyEntry[] } };
  const flaky = (manifest.aggregates?.flakiness ?? []).filter(
    (entry) => entry.score >= minScore && entry.runs >= minRuns,
  );

  const locations = new Map<string, { file: string; line: number }>();
  const detailsDir = path.join(reportDir, 'data', 'details');
  let names: string[] = [];
  try {
    names = (await readdir(detailsDir)).filter((f) => f.endsWith('.js'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const raw = await readFile(path.join(detailsDir, name), 'utf8');
    const details = JSON.parse(raw.slice(raw.indexOf(', ') + 2, raw.lastIndexOf(');'))) as Array<{
      caseId: string;
      location: { file: string; line: number };
    }>;
    for (const detail of details) {
      locations.set(detail.caseId, { file: detail.location.file, line: detail.location.line });
    }
  }

  return flaky
    .map((entry) => ({
      caseId: entry.caseId,
      title: entry.title,
      projectName: entry.projectName,
      failures: entry.flakyRuns + entry.failedRuns,
      runs: entry.runs,
      file: locations.get(entry.caseId)?.file,
      line: locations.get(entry.caseId)?.line,
    }))
    .sort((a, b) => b.failures / b.runs - a.failures / a.runs);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function toGrepInvert(candidates: QuarantineCandidate[]): string {
  const titles = [...new Set(candidates.map((c) => escapeRegex(c.title)))];
  if (titles.length === 0) return '';
  if (titles.length === 1) return `^${titles[0]}$`;
  return `^(?:${titles.join('|')})$`;
}

/** Suggested test.fixme edits, one block per candidate. */
export function toFixmeSuggestions(candidates: QuarantineCandidate[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const c of candidates) {
    const key = `${c.file}:${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(
      [
        `// ${c.file}:${c.line} — flaky in ${c.failures}/${c.runs} recent runs`,
        '//   add inside the test:',
        "//   test.fixme(true, 'quarantined: flaky — see beacon report');",
      ].join('\n'),
    );
  }
  return blocks.join('\n\n');
}
