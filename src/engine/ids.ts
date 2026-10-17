import { createHash } from 'node:crypto';

/**
 * Stable test identity across runs AND across Playwright versions — deliberately
 * our own hash rather than Playwright's internal test id, so history survives
 * Playwright upgrades. A rename is "removed + new" in schema v1 (rename
 * detection is a stated post-1.0 non-goal).
 *
 * Node-only (subpath export `@beacon-report/shared/ids`); never import from the UI.
 */
export function computeCaseId(projectName: string, file: string, titlePath: string[]): string {
  return createHash('sha1')
    .update([projectName, file, ...titlePath].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}
