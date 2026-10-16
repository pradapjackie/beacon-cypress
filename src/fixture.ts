/** The slice of a Beacon fixture this package builds. Kept local so the public types do not import Playwright. */

export interface BeaconFixture {
  recorderVersion: number;
  recordedAt: string;
  events: BeaconEvent[];
}

export type BeaconEvent =
  | {
      type: 'onBegin';
      config: { workers: number; fullyParallel: boolean; projectNames: string[] };
    }
  | TestEnd
  | { type: 'onEnd'; status: string };

export interface TestEnd {
  type: 'onTestEnd';
  test: {
    title: string;
    titlePath: string[];
    file: string;
    line: number;
    column: number;
    projectName: string;
    tags: string[];
    annotations: Array<{ type: string; description?: string }>;
    timeout: number;
    outcome: string;
  };
  result: {
    retry: number;
    workerIndex: number;
    parallelIndex: number;
    startTime: number;
    duration: number;
    status: string;
    errors: Array<{ message?: string; stack?: string; snippet?: string }>;
    stdout: Array<{ text: string }>;
    stderr: Array<{ text: string }>;
    attachments: Array<{ name: string; contentType: string; path: string }>;
    steps: Array<{
      title: string;
      category: string;
      startTime: number;
      duration: number;
      steps: TestEnd['result']['steps'];
      error?: { message: string };
    }>;
  };
}
