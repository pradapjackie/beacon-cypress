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
| `scrub` | — | Same redaction rules as Beacon. Applied to errors and text attachments. |
| `environment` | browser, Cypress version, OS | Extra key-values on the environment card. |

An example spec lives in `examples/`.
