import { describe, expect, it } from 'vitest';
import { keyForAttempt } from '../src/keys';
import { compileScrub } from '../src/scrub';

describe('keyForAttempt', () => {
  it('reuses the first attempt’s key for retries, then numbers the next test', () => {
    const seen = new Map<string, number>();
    expect(keyForAttempt(seen, 'cypress/e2e/a.cy.js', ['S', 'flaky'], 0)).toBe('cypress/e2e/a.cy.js::S > flaky');
    expect(keyForAttempt(seen, 'cypress/e2e/a.cy.js', ['S', 'flaky'], 1)).toBe('cypress/e2e/a.cy.js::S > flaky');
    expect(keyForAttempt(seen, 'cypress/e2e/a.cy.js', ['S', 'flaky'], 0)).toBe('cypress/e2e/a.cy.js::S > flaky #2');
    expect(keyForAttempt(seen, 'cypress/e2e/a.cy.js', ['S', 'flaky'], 2)).toBe('cypress/e2e/a.cy.js::S > flaky #2');
  });
});

describe('compileScrub', () => {
  it('redacts every match when flags omit g', () => {
    const { apply } = compileScrub([{ pattern: 'a', flags: 'i', replacement: 'X' }]);
    expect(apply('aAa')).toBe('XXX');
  });
});
