import type { BeaconFixture, TestEnd } from './fixture';
import { commandKey, duplicateIndex } from './keys';
import type {
  CypressAttempt,
  CypressCommand,
  CypressCommandLineResults,
  CypressScreenshot,
  CypressSpecRun,
  CypressTestResult,
} from './types';

export { commandKey };

/** One list per attempt, or a single list from older callers. */
export type CommandLogMap = Map<string, CypressCommand[] | CypressCommand[][]>;

/** Screenshots reported by the browser collector, keyed by test then attempt. */
export type RecordedScreenshots = Map<string, Map<number, CypressScreenshot[]>>;

const ILLEGAL_FILENAME = /[/?<>\\:*|"]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u0080-\u009f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Cypress after:run results, plus command logs collected in the browser,
 * shaped as the event stream Beacon already replays.
 */
export function toBeaconFixture(
  results: CypressCommandLineResults,
  commands: CommandLogMap,
  scrub: (text: string) => string = (text) => text,
  recordedShots?: RecordedScreenshots,
): BeaconFixture {
  const projectName = results.browserName || 'cypress';
  const events: BeaconFixture['events'] = [
    {
      type: 'onBegin',
      config: {
        workers: 1,
        fullyParallel: false,
        projectNames: [projectName],
      },
    },
  ];

  let tests = 0;
  for (const run of results.runs ?? []) {
    const cursor = {
      value: timeOf(run.stats?.startedAt) || timeOf(results.startedTestsAt) || Date.now(),
    };
    const seen = new Map<string, number>();
    const shotIndex = indexScreenshots(run.screenshots ?? []);
    for (const test of run.tests ?? []) {
      tests += 1;
      const duplicate = duplicateIndex(seen, test.title);
      events.push(
        ...testEvents(run, test, projectName, commands, cursor, duplicate, scrub, shotIndex, recordedShots),
      );
    }
    if (run.error) {
      tests += 1;
      events.push(specErrorEvent(run, projectName, cursor, scrub));
    }
  }

  if (tests === 0 && results.status === 'failed') {
    events.push(runErrorEvent(results, projectName, scrub));
  }

  const failed =
    results.status === 'failed' ||
    (results.runs ?? []).some(
      (run) => Boolean(run.error) || (run.tests ?? []).some((test) => finalState(test) === 'failed'),
    );
  events.push({ type: 'onEnd', status: failed ? 'failed' : 'passed' });

  return {
    recorderVersion: 1,
    recordedAt: new Date().toISOString(),
    events,
  };
}

function testEvents(
  run: CypressSpecRun,
  test: CypressTestResult,
  projectName: string,
  commands: CommandLogMap,
  cursor: { value: number },
  duplicate: number,
  scrub: (text: string) => string,
  shotIndex: ShotIndex,
  recordedShots?: RecordedScreenshots,
): TestEnd[] {
  const attempts = test.attempts?.length ? test.attempts : [fallbackAttempt(test)];
  const outcome = outcomeOf(test);
  const shots = classifyScreenshots(test, shotIndex);
  const logged = commandAttempts(commands, run.spec.relative, test.title, attempts.length, duplicate);
  const title = displayTitle(test.title, duplicate);
  const videoTarget = (run.tests ?? []).find((candidate) => !skippedState(finalState(candidate)));
  const specFailed = (run.tests ?? []).some((candidate) => finalState(candidate) === 'failed') || Boolean(run.error);

  return attempts.map((attempt, index) => {
    const failed = attempt.state === 'failed';
    const attachments: Array<{ name: string; contentType: string; path: string }> = [];
    for (const shot of shots.failures.get(index) ?? []) attachments.push(imageAttachment(shot));
    if (index === attempts.length - 1) {
      for (const shot of shots.manual) attachments.push(imageAttachment(shot));
    }
    const recorded =
      recordedShots?.get(commandKey(run.spec.relative, test.title, duplicate))?.get(index) ?? [];
    for (const shot of recorded) {
      if (attachments.some((attachment) => attachment.path === shot.path)) continue;
      attachments.push(imageAttachment(shot));
    }
    const showVideo = specFailed ? failed : test === videoTarget;
    if (run.video && index === attempts.length - 1 && showVideo) {
      attachments.push({
        name: 'video',
        contentType: contentTypeFor(run.video),
        path: run.video,
      });
    }
    const error = attempt.error;
    const steps = stepsFrom(logged[index] ?? [], scrub);
    const timing = attemptTiming(attempt, test, index, attempts.length, cursor);
    const commandError = steps.find((step) => step.error)?.error?.message;
    return {
      type: 'onTestEnd' as const,
      test: {
        title: title.at(-1) ?? 'test',
        titlePath: ['', projectName, run.spec.relative, ...title],
        file: run.spec.relative,
        line: 1,
        column: 1,
        projectName,
        tags: tagsIn(test.title, test.tags),
        annotations: [],
        timeout: 0,
        // The reporter keeps the test object from the first attempt.
        outcome,
      },
      result: {
        retry: index,
        workerIndex: 0,
        parallelIndex: 0,
        startTime: timing.startTime,
        duration: timing.duration,
        status: statusOf(attempt.state),
        errors: failed
          ? [
              {
                message: scrub(
                  error?.message ||
                    (index === attempts.length - 1 ? test.displayError : undefined) ||
                    commandError ||
                    (index === attempts.length - 1
                      ? 'failed'
                      : 'failed (details only recorded for the final attempt)'),
                ),
                stack: error?.stack ? scrub(error.stack) : undefined,
                snippet: error?.codeFrame?.frame ? scrub(error.codeFrame.frame) : undefined,
              },
            ]
          : [],
        stdout: [],
        stderr: [],
        attachments,
        steps,
      },
    };
  });
}

function specErrorEvent(
  run: CypressSpecRun,
  projectName: string,
  cursor: { value: number },
  scrub: (text: string) => string,
): TestEnd {
  const attachments = run.video
    ? [{ name: 'video', contentType: contentTypeFor(run.video), path: run.video }]
    : [];
  return {
    type: 'onTestEnd',
    test: {
      title: 'failed to load',
      titlePath: ['', projectName, run.spec.relative, 'failed to load'],
      file: run.spec.relative,
      line: 1,
      column: 1,
      projectName,
      tags: [],
      annotations: [],
      timeout: 0,
      outcome: 'unexpected',
    },
    result: {
      retry: 0,
      workerIndex: 0,
      parallelIndex: 0,
      startTime: cursor.value,
      duration: 0,
      status: 'failed',
      errors: [{ message: scrub(run.error || 'The spec failed before any test ran') }],
      stdout: [],
      stderr: [],
      attachments,
      steps: [],
    },
  };
}

function runErrorEvent(
  results: CypressCommandLineResults,
  projectName: string,
  scrub: (text: string) => string,
): TestEnd {
  return {
    type: 'onTestEnd',
    test: {
      title: 'Cypress run failed',
      titlePath: ['', projectName, 'Cypress run failed'],
      file: '',
      line: 1,
      column: 1,
      projectName,
      tags: [],
      annotations: [],
      timeout: 0,
      outcome: 'unexpected',
    },
    result: {
      retry: 0,
      workerIndex: 0,
      parallelIndex: 0,
      startTime: timeOf(results.startedTestsAt) || Date.now(),
      duration: results.totalDuration ?? 0,
      status: 'failed',
      errors: [{ message: scrub(results.message || 'Cypress run failed') }],
      stdout: [],
      stderr: [],
      attachments: [],
      steps: [],
    },
  };
}

function displayTitle(title: string[], duplicate: number): string[] {
  if (duplicate === 0) return title;
  const leaf = title.at(-1) ?? 'test';
  return [...title.slice(0, -1), `${leaf} (${duplicate + 1})`];
}

function attemptTiming(
  attempt: CypressAttempt,
  test: CypressTestResult,
  index: number,
  attemptCount: number,
  cursor: { value: number },
): { startTime: number; duration: number } {
  const parsed = timeOf(attempt.wallClockStartedAt);
  const duration =
    typeof attempt.wallClockDuration === 'number'
      ? attempt.wallClockDuration
      : index === attemptCount - 1
        ? (test.duration ?? 0)
        : 0;
  if (parsed) return { startTime: parsed, duration };
  const startTime = cursor.value;
  cursor.value += duration;
  return { startTime, duration };
}

function timeOf(value: string | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function fallbackAttempt(test: CypressTestResult): CypressAttempt {
  return {
    state: test.state,
    error: test.displayError ? { message: test.displayError } : null,
    wallClockDuration: 0,
  };
}

function finalState(test: CypressTestResult): string {
  const attempts = test.attempts?.length ? test.attempts : [fallbackAttempt(test)];
  return attempts.at(-1)?.state ?? test.state;
}

function skippedState(state: string): boolean {
  return state === 'pending' || state === 'skipped';
}

function outcomeOf(test: CypressTestResult): 'expected' | 'unexpected' | 'flaky' | 'skipped' {
  const attempts = test.attempts?.length ? test.attempts : [fallbackAttempt(test)];
  const states = attempts.map((attempt) => attempt.state);
  const last = states.at(-1) ?? test.state;
  if (skippedState(last)) return 'skipped';
  if (last === 'passed' && states.some((state) => state === 'failed')) return 'flaky';
  if (last === 'passed') return 'expected';
  return 'unexpected';
}

function statusOf(state: string): 'passed' | 'failed' | 'skipped' | 'timedOut' {
  if (state === 'passed') return 'passed';
  if (skippedState(state)) return 'skipped';
  return 'failed';
}

function tagsIn(title: string[], extra?: string[]): string[] {
  const withoutEmails = title.join(' ').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, ' ');
  const fromTitle = withoutEmails.match(/@[\w-]+/g) ?? [];
  const fromConfig = (extra ?? []).map((tag) => (tag.startsWith('@') ? tag : `@${tag}`));
  return [...new Set([...fromTitle, ...fromConfig])];
}

function commandAttempts(
  commands: CommandLogMap,
  specRelative: string,
  title: string[],
  attemptCount: number,
  duplicate: number,
): CypressCommand[][] {
  const stored = commands.get(commandKey(specRelative, title, duplicate));
  if (!stored || stored.length === 0) return [];
  if (isAttemptList(stored)) return normalizeAttempts(stored);
  const flat = (stored as CypressCommand[]).filter(isCommand);
  if (attemptCount <= 1) return [flat];
  const padded = Array.from({ length: attemptCount }, () => [] as CypressCommand[]);
  padded[attemptCount - 1] = flat;
  return padded;
}

/** A nested list, including a sparse one whose first slot is empty. */
export function isAttemptList(stored: CypressCommand[] | CypressCommand[][]): stored is CypressCommand[][] {
  for (let index = 0; index < stored.length; index += 1) {
    if (Array.isArray(stored[index])) return true;
  }
  return false;
}

export function normalizeAttempts(stored: CypressCommand[] | CypressCommand[][]): CypressCommand[][] {
  const attempts: CypressCommand[][] = [];
  for (let index = 0; index < stored.length; index += 1) {
    const entry = stored[index];
    attempts[index] = Array.isArray(entry) ? entry.filter(isCommand) : [];
  }
  return attempts;
}

function isCommand(value: unknown): value is CypressCommand {
  return Boolean(value) && typeof value === 'object' && typeof (value as CypressCommand).name === 'string';
}

const MAX_STEP_CHARS = 4_000;

function stepsFrom(commands: CypressCommand[], scrub: (text: string) => string): TestEnd['result']['steps'] {
  const steps: TestEnd['result']['steps'] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!isCommand(command)) continue;
    const next = commands.slice(index + 1).find(isCommand)?.startedAt;
    const duration =
      command.startedAt != null && next != null && next >= command.startedAt ? next - command.startedAt : 0;
    const raw = command.message ? `${command.name} ${command.message}` : command.name;
    const title = clip(scrub(raw));
    steps.push({
      title,
      category: 'test.step',
      startTime: command.startedAt ?? index,
      duration,
      steps: [],
      ...(command.state === 'failed' ? { error: { message: title } } : {}),
    });
  }
  return steps;
}

function clip(value: string): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= MAX_STEP_CHARS) return text;
  return `${text.slice(0, MAX_STEP_CHARS)}…`;
}

function imageAttachment(shot: CypressScreenshot): { name: string; contentType: string; path: string } {
  return {
    name: shot.name || 'screenshot',
    contentType: 'image/png',
    path: shot.path,
  };
}

interface ShotIndex {
  /** Sanitized title segment → screenshots that contain it. */
  byLeaf: Map<string, CypressScreenshot[]>;
  /** Names long enough that Cypress may have truncated them. */
  long: CypressScreenshot[];
}

function indexScreenshots(shots: CypressScreenshot[]): ShotIndex {
  const byLeaf = new Map<string, CypressScreenshot[]>();
  const long: CypressScreenshot[] = [];
  for (const shot of shots) {
    const base = shotBase(shot);
    if (Buffer.byteLength(base) >= 240) long.push(shot);
    const keys = new Set<string>();
    for (const part of shotParts(shot)) {
      const failed = part.match(/^(.*) \(failed\)(?: \(attempt (\d+)\))?$/);
      const leaf = sanitizeTitle(failed?.[1] ?? part);
      if (leaf) keys.add(leaf);
    }
    for (const key of keys) {
      const list = byLeaf.get(key) ?? [];
      list.push(shot);
      byLeaf.set(key, list);
    }
  }
  return { byLeaf, long };
}

function candidatesFor(test: CypressTestResult, index: ShotIndex): CypressScreenshot[] {
  const titles = test.title.filter(Boolean);
  const leaf = sanitizeTitle(titles.at(-1) ?? '');
  const direct = leaf ? (index.byLeaf.get(leaf) ?? []) : [];
  const body = titles.map((title) => sanitizeTitle(title)).join(' -- ');
  if (Buffer.byteLength(body) < 200 || index.long.length === 0) return direct;
  const seen = new Set(direct);
  return [...direct, ...index.long.filter((shot) => !seen.has(shot))];
}

/**
 * Cypress names failures `<titles joined by " -- "> (failed).png`, and retries
 * `<titles> (failed) (attempt N).png` with N starting at 2. Characters that
 * cannot live in a filename are removed first, and the basename is cut to
 * 250 bytes. A shorter title must not claim a longer one.
 */
function classifyScreenshots(
  test: CypressTestResult,
  index: ShotIndex,
): { failures: Map<number, CypressScreenshot[]>; manual: CypressScreenshot[] } {
  const failures = new Map<number, CypressScreenshot[]>();
  const manual: CypressScreenshot[] = [];
  const titles = test.title.filter(Boolean);
  if (titles.length === 0) return { failures, manual };
  for (const shot of candidatesFor(test, index)) {
    const parts = shotParts(shot);
    const located = locateTitle(parts, titles) ?? truncatedAttempt(shotBase(shot), titles);
    if (!located) continue;
    if (located.attempt != null) {
      const index = located.attempt - 1;
      const list = failures.get(index) ?? [];
      list.push(shot);
      failures.set(index, list);
      continue;
    }
    manual.push(shot);
  }
  return { failures, manual };
}

function shotParts(shot: CypressScreenshot): string[] {
  return shotBase(shot)
    .split(' -- ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shotBase(shot: CypressScreenshot): string {
  const raw = shot.name || shot.path.split(/[/\\]/).pop() || '';
  return raw.replace(/\.png$/i, '');
}

function locateTitle(parts: string[], titles: string[]): { attempt: number | null } | null {
  const leaf = titles[titles.length - 1] ?? '';
  for (let start = 0; start <= parts.length - titles.length; start += 1) {
    const headsMatch = titles
      .slice(0, -1)
      .every((title, index) => sanitizeTitle(parts[start + index] ?? '') === sanitizeTitle(title));
    if (!headsMatch) continue;
    const last = parts[start + titles.length - 1] ?? '';
    if (sanitizeTitle(last) === sanitizeTitle(leaf)) return { attempt: null };
    const failed = last.match(/^(.*) \(failed\)(?: \(attempt (\d+)\))?$/);
    if (failed && sanitizeTitle(failed[1] ?? '') === sanitizeTitle(leaf)) {
      return { attempt: failed[2] ? Number(failed[2]) : 1 };
    }
  }
  return null;
}

function truncatedAttempt(base: string, titles: string[]): { attempt: number | null } | null {
  if (Buffer.byteLength(base) < 240) return null;
  const body = titles.map((title) => sanitizeTitle(title)).join(' -- ');
  const visible = base.match(/\(attempt (\d+)\)/);
  const attempts = visible ? [Number(visible[1])] : [1];
  for (const attempt of attempts) {
    const suffix = attempt === 1 ? ' (failed)' : ` (failed) (attempt ${attempt})`;
    const full = `${body}${suffix}`;
    if (Buffer.byteLength(base) < Buffer.byteLength(full) && isBytePrefix(base, full)) return { attempt };
  }
  if (Buffer.byteLength(base) < Buffer.byteLength(body) && isBytePrefix(base, body)) return { attempt: null };
  const manual = `${body} -- `;
  if (Buffer.byteLength(manual) < Buffer.byteLength(base) && startsWithBytes(base, manual)) return { attempt: null };
  return null;
}

/** Same characters Cypress removes with sanitize-filename before writing a screenshot. */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(ILLEGAL_FILENAME, '')
    .replace(CONTROL_CHARS, '')
    .replace(/^\.+$/, '')
    .replace(WINDOWS_RESERVED, '')
    .replace(/[. ]+$/g, '');
  const bytes = Buffer.from(cleaned);
  if (bytes.byteLength <= 255) return cleaned;
  return bytes.subarray(0, 255).toString('utf8').replace(/\uFFFD$/, '');
}

function isBytePrefix(prefix: string, full: string): boolean {
  const pre = Buffer.from(prefix);
  const all = Buffer.from(full);
  if (pre.byteLength > all.byteLength) return false;
  return pre.equals(all.subarray(0, pre.byteLength));
}

function startsWithBytes(value: string, prefix: string): boolean {
  return isBytePrefix(prefix, value);
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}
