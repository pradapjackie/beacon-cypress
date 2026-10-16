import type { RecordedFixture } from 'beacon-reporter/replay';
import type {
  CypressAttempt,
  CypressCommand,
  CypressCommandLineResults,
  CypressScreenshot,
  CypressSpecRun,
  CypressTestResult,
} from './types';

type FixtureEvent = RecordedFixture['events'][number];
type TestEnd = Extract<FixtureEvent, { type: 'onTestEnd' }>;

export function commandKey(specRelative: string, title: string[]): string {
  return `${specRelative}::${title.join(' > ')}`;
}

/**
 * Cypress after:run results, plus command logs collected in the browser,
 * shaped as the event stream Beacon already replays.
 */
export function toBeaconFixture(
  results: CypressCommandLineResults,
  commands: Map<string, CypressCommand[]>,
): RecordedFixture {
  const projectName = results.browserName || 'cypress';
  const events: RecordedFixture['events'] = [
    {
      type: 'onBegin',
      config: {
        workers: 1,
        fullyParallel: false,
        projectNames: [projectName],
      },
    },
  ];

  for (const run of results.runs ?? []) {
    const cursor = {
      value: timeOf(run.stats?.startedAt) || timeOf(results.startedTestsAt) || Date.now(),
    };
    for (const test of run.tests ?? []) {
      events.push(...testEvents(run, test, projectName, commands, cursor));
    }
  }

  const failed = (results.runs ?? []).some((run) =>
    (run.tests ?? []).some((test) => finalState(test) === 'failed'),
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
  commands: Map<string, CypressCommand[]>,
  cursor: { value: number },
): TestEnd[] {
  const attempts = test.attempts?.length ? test.attempts : [fallbackAttempt(test)];
  const outcome = outcomeOf(test);
  const shots = screenshotsFor(test, run.screenshots ?? []);
  const logged = commandsFor(commands, run.spec.relative, test.title);
  const isFirst = run.tests?.[0] === test;
  const specFailed = (run.tests ?? []).some((candidate) => finalState(candidate) === 'failed');
  const steps = logged.map((command, index) => ({
    title: command.message ? `${command.name} ${command.message}` : command.name,
    category: 'test.step',
    startTime: command.startedAt ?? index,
    duration: 0,
    steps: [],
    ...(command.state === 'failed' ? { error: { message: `${command.name} failed` } } : {}),
  }));

  return attempts.map((attempt, index) => {
    const failed = attempt.state === 'failed';
    const attachments: Array<{ name: string; contentType: string; path: string }> = [];
    if (failed) {
      for (const shot of shots) {
        attachments.push({
          name: shot.name || 'screenshot',
          contentType: 'image/png',
          path: shot.path,
        });
      }
    }
    const showVideo = specFailed ? failed : isFirst;
    if (run.video && index === attempts.length - 1 && showVideo) {
      attachments.push({
        name: 'video',
        contentType: contentTypeFor(run.video),
        path: run.video,
      });
    }
    const error = attempt.error;
    const timing = attemptTiming(attempt, test, index, attempts.length, cursor);
    return {
      type: 'onTestEnd' as const,
      test: {
        title: test.title.at(-1) ?? 'test',
        titlePath: ['', projectName, run.spec.relative, ...test.title],
        file: run.spec.relative,
        line: 1,
        column: 1,
        projectName,
        tags: tagsIn(test.title),
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
                message: error?.message || test.displayError || 'failed',
                stack: error?.stack,
                snippet: error?.codeFrame?.frame,
              },
            ]
          : [],
        stdout: [],
        stderr: [],
        attachments,
        steps: index === attempts.length - 1 ? steps : [],
      },
    };
  });
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

function outcomeOf(test: CypressTestResult): 'expected' | 'unexpected' | 'flaky' | 'skipped' {
  const attempts = test.attempts?.length ? test.attempts : [fallbackAttempt(test)];
  const states = attempts.map((attempt) => attempt.state);
  const last = states.at(-1) ?? test.state;
  if (last === 'pending' || last === 'skipped') return 'skipped';
  if (last === 'passed' && states.some((state) => state === 'failed')) return 'flaky';
  if (last === 'passed') return 'expected';
  return 'unexpected';
}

function statusOf(state: string): 'passed' | 'failed' | 'skipped' | 'timedOut' {
  if (state === 'passed') return 'passed';
  if (state === 'pending' || state === 'skipped') return 'skipped';
  return 'failed';
}

function tagsIn(title: string[]): string[] {
  return [...new Set(title.join(' ').match(/@[\w-]+/g) ?? [])];
}

function commandsFor(
  commands: Map<string, CypressCommand[]>,
  specRelative: string,
  title: string[],
): CypressCommand[] {
  const exact = commands.get(commandKey(specRelative, title));
  if (exact) return exact;
  const suffix = `::${title.join(' > ')}`;
  for (const [key, value] of commands) {
    if (key.endsWith(suffix)) return value;
  }
  return [];
}

function screenshotsFor(test: CypressTestResult, shots: CypressScreenshot[]): CypressScreenshot[] {
  const full = test.title.join(' -- ');
  const leaf = test.title.at(-1) ?? '';
  const haystack = (shot: CypressScreenshot) => `${shot.name ?? ''} ${shot.path}`;
  const fullMatches = shots.filter((shot) => haystack(shot).includes(full));
  if (fullMatches.length > 0) return fullMatches;
  return leaf.length > 0 ? shots.filter((shot) => haystack(shot).includes(leaf)) : [];
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}
