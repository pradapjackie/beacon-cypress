// BEACON_MODE=fix makes the failing test pass for one run, so history can show a fix and a later regression.
const mode = Cypress.env('BEACON_MODE');

describe('beacon', () => {
  it('passes @smoke', () => {
    cy.wrap(1).should('eq', 1);
  });

  it('fails the assertion', () => {
    cy.wrap(1).should('eq', mode === 'fix' ? 1 : 2);
  });

  it.skip('is skipped @wip', () => {
    cy.wrap(true).should('eq', true);
  });

  it('retries then passes @flaky', { retries: 1 }, () => {
    expect(Cypress.currentRetry, 'retry').to.eq(1);
  });
});
