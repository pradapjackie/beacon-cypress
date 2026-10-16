import { defineConfig } from 'cypress';
import { beaconCypress } from 'beacon-cypress';

export default defineConfig({
  e2e: {
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    video: true,
    setupNodeEvents: beaconCypress({ title: 'Cypress demo' }),
  },
});
