import path from 'node:path';
import { AttachmentStore } from './engine/attachments';
import { parseBudget } from './engine/analytics';
import { computeCaseId } from './engine/ids';
import type { Annotation, TestDetail, TestResultRecord, TestStatus } from './engine/schema';
import type { CypressReportData, ReportAttempt, ReportTest } from './map-results';

const OUTCOME = {
  passed: 'expected',
  failed: 'unexpected',
  flaky: 'flaky',
  skipped: 'skipped',
} as const;

/**
 * Cypress tests in the report shape the shared Beacon UI reads.
 * Screenshots and video are copied into the content-addressed attachment store.
 */
export async function toTestDetails(
  report: CypressReportData,
  outputDir: string,
): Promise<{ details: TestDetail[]; owned: string[] }> {
  const store = new AttachmentStore(path.join(outputDir, 'attachments'));
  const projectName = report.browser || 'cypress';
  const owned: string[] = [];
  const details: TestDetail[] = [];
  for (const test of report.tests) {
    const file = test.spec || 'cypress';
    const titlePath = ['', projectName, file, ...test.titlePath];
    const annotations = annotationsOf(test);
    const budgetMs = parseBudget(annotations.find((note) => note.type === 'budget')?.description);
    const results: TestResultRecord[] = [];
    for (let index = 0; index < test.attempts.length; index += 1) {
      const attempt = test.attempts[index] as ReportAttempt;
      const attachments = [];
      for (const shot of attempt.screenshots) {
        const ref = await store.put({
          name: shot.name || 'screenshot',
          contentType: contentType(shot.path, 'image/png'),
          path: shot.path,
        });
        if (ref.mode === 'omitted') continue;
        remember(owned, ref);
        attachments.push(ref);
      }
      if (attempt.video) {
        const ref = await store.put({
          name: 'video',
          contentType: contentType(attempt.video.path, 'video/mp4'),
          path: attempt.video.path,
        });
        if (ref.mode !== 'omitted') {
          remember(owned, ref);
          attachments.push(ref);
        }
      }
      results.push({
        retry: index,
        workerIndex: 0,
        parallelIndex: 0,
        startTime: attempt.startTime,
        duration: attempt.duration,
        status: statusOf(attempt),
        errors: attempt.error
          ? [
              {
                message: attempt.error.message,
                ...(attempt.error.stack ? { stack: attempt.error.stack } : {}),
                ...(attempt.error.frame ? { snippet: attempt.error.frame } : {}),
              },
            ]
          : [],
        stdio: [],
        attachments,
        steps: stepsOf(attempt),
        visualDiffs: [],
      });
    }
    details.push({
      caseId: computeCaseId(projectName, file, titlePath),
      title: test.title,
      titlePath,
      location: { file, line: 0, column: 0 },
      projectName,
      tags: test.tags,
      annotations,
      outcome: OUTCOME[test.outcome],
      timeout: 0,
      slow: false,
      ...(budgetMs !== undefined ? { budgetMs } : {}),
      results,
    });
  }
  return { details, owned };
}

function remember(owned: string[], ref: { mode: string; sha256?: string; ext?: string }): void {
  if (ref.mode === 'stored' && ref.sha256) owned.push(`attachments/${ref.sha256}.${ref.ext ?? 'bin'}`);
}

const ANNOTATION = /(?:^|[\s@])(owner|severity|requirement|budget|issue)\s*[:=]\s*(\S+)/gi;

/** `owner:` / `severity:` / … anywhere in a title, or on a tag with or without `@`. */
export function annotationsIn(texts: string[]): Annotation[] {
  const notes: Annotation[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const source = raw.trim().replace(/^@/, '');
    for (const match of source.matchAll(ANNOTATION)) {
      const type = match[1].toLowerCase();
      const description = match[2].trim();
      const key = `${type}\u0000${description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push({ type, description });
    }
  }
  return notes;
}

function annotationsOf(test: ReportTest): Annotation[] {
  return annotationsIn([...test.titlePath, ...test.tags.map((tag) => tag.replace(/^@/, ''))]);
}

function statusOf(attempt: ReportAttempt): TestStatus {
  if (attempt.status === 'passed') return 'passed';
  if (attempt.status === 'skipped') return 'skipped';
  if (/timed out|timeout/i.test(attempt.error?.message ?? '')) return 'timedOut';
  return 'failed';
}

function stepsOf(attempt: ReportAttempt): TestResultRecord['steps'] {
  let cursor = attempt.startTime;
  return attempt.commands.map((command) => {
    const failed = command.state === 'failed';
    const step = {
      title: command.title,
      category: command.title.startsWith('assert') ? 'expect' : 'command',
      startTime: cursor,
      duration: command.duration,
      attachments: [] as number[],
      steps: [],
      ...(failed ? { error: { message: command.title } } : {}),
    };
    cursor += command.duration;
    return step;
  });
}

function contentType(file: string, fallback: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  return fallback;
}
