# beacon-cypress

Beacon reports for Cypress. The dashboard, test list, history, compare, and flaky pages are the same ones [`beacon-reporter`](https://www.npmjs.com/package/beacon-reporter) ships for Playwright. This package collects a Cypress run and writes that report.

Screenshots, the spec video, retries, and the Cypress command log are included. Cypress has no Playwright trace zip and no worker pool, so those two views stay empty.

## Setup

```js
import { defineConfig } from 'cypress';
import { beaconCypress } from 'beacon-cypress';

export default defineConfig({
  e2e: {
    setupNodeEvents: beaconCypress({ title: 'Checkout' }),
  },
});
```

In `cypress/support/e2e.js`, so the command log is recorded:

```js
import { installBeaconCollector } from 'beacon-cypress/support';

installBeaconCollector();
```

`setupNodeEvents` replaces whatever was there, and Cypress keeps only one `after:run` handler. Register Beacon and pass `.chain()` into the other plugins so both reports still run:

```js
import { defineConfig } from 'cypress';
import { beaconCypress } from 'beacon-cypress';
import coverage from '@cypress/code-coverage/task';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      const next = beaconCypress({ title: 'Checkout' }).chain(on, config);
      coverage(next, config);
      return config;
    },
  },
});
```

Use the same `setupNodeEvents` entry for component tests if `cypress/support/component.js` calls `installBeaconCollector()`. Without the plugin, the collector does nothing, so a missing task does not fail the suite. Command logs are recorded only where the plugin is registered.

Hide secrets from the command log with `{ log: false }`. Values that still appear in an error can be redacted with `scrub`:

```js
cy.get('#password').type(password, { log: false });

beaconCypress({
  scrub: [{ pattern: 'token=[^&\\s]+', replacement: 'token=[redacted]' }],
});
```

`scrub` is an array of `{ pattern, flags?, replacement? }`. `pattern` is a regular expression string. An object instead of an array is ignored.

After `cypress run`, open the report:

```bash
npx beacon open beacon-report
```

`beacon` comes from `beacon-reporter`, which this package installs for you.

## Options

`beaconCypress({ ... })` accepts:

| Option | Default | |
|---|---|---|
| `outputFolder` | `beacon-report` | Report directory, relative to the Cypress project. |
| `title` | `Cypress` | Header title. |
| `history` | `.beacon-history`, 30 runs | Pass `false` to skip history. |
| `categories` | — | Same failure category rules as Beacon. |
| `scrub` | — | Array of `{ pattern, flags?, replacement? }`. Applied to errors, command steps, and text attachments. |
| `environment` | browser, Cypress version, OS | Extra key-values on the environment card. |

An example spec is in [`examples/`](https://github.com/pradapjackie/beacon-cypress/tree/main/examples) on GitHub and in the `examples/` folder of the published package. `@cypress/grep` tags live on the test config, which Cypress does not include in `after:run`, so only tags written in the title (or a `tags` array on the test result) show on the report. Named `cy.screenshot('checkout-page')` images are recorded when the collector is on. `scrub` flags always match every occurrence, so `flags: 'i'` still redacts the whole string.
