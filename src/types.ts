/** The slice of Cypress's after:run payload this reporter reads. */
export interface CypressCommandLineResults {
  status: 'finished' | 'failed';
  startedTestsAt?: string;
  endedTestsAt?: string;
  totalDuration?: number;
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  cypressVersion?: string;
  runs?: CypressSpecRun[];
  message?: string;
}

export interface CypressSpecRun {
  spec: { name?: string; relative: string; absolute?: string };
  /** Set when the spec crashed before any test, for example a syntax or import error. */
  error?: string | null;
  video?: string | null;
  screenshots?: CypressScreenshot[];
  tests?: CypressTestResult[];
  /** Present on Cypress's after:run payload. Attempts no longer carry timings. */
  stats?: { startedAt?: string; endedAt?: string; duration?: number };
}

export interface CypressScreenshot {
  path: string;
  name?: string;
  takenAt?: string;
}

export interface CypressTestResult {
  title: string[];
  state: string;
  /** Whole-test duration in ms. Cypress 15 puts timing here, not on attempts. */
  duration?: number;
  displayError?: string | null;
  attempts?: CypressAttempt[];
  /** @cypress/grep puts these on the test config. Cypress's public results omit them. */
  tags?: string[];
}

export interface CypressAttempt {
  state: string;
  error?: { name?: string; message?: string; stack?: string; codeFrame?: { frame?: string } } | null;
  wallClockStartedAt?: string;
  wallClockDuration?: number;
}

/** One Cypress command, sent from the browser support file. */
export interface CypressCommand {
  name: string;
  message: string;
  state: string;
  startedAt?: number;
}

export interface CommandLog {
  /** `${specRelative}::${title joined with ' > '}` */
  key: string;
  /** Zero-based retry index. Each attempt keeps its own command list. */
  attempt?: number;
  /** After-hook commands are added to the attempt instead of replacing it. */
  append?: boolean;
  commands: CypressCommand[];
  /** Screenshots taken during this attempt, including named `cy.screenshot()` calls. */
  screenshots?: CypressScreenshot[];
}
