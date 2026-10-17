# beacon-cypress

Beacon reports for Cypress. This package collects a Cypress run and writes the same Beacon report as beacon-reporter: dashboard, tests, compare, timeline, flaky scores, trends, media, requirements, and run history. It does not install Playwright.

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
npx beacon-cypress open beacon-report
```

The report is the Beacon UI plus an `attachments/` folder. `open` serves that folder on a local port. The same folder also accepts `export`, `gate`, `summarize`, `convert`, `quarantine`, `diff`, `notify`, `archive`, and `history`.

## Options

`beaconCypress({ ... })` accepts:

| Option | Default | |
|---|---|---|
| `outputFolder` | `beacon-report` | Report directory, relative to the Cypress project. An existing `index.html` that is not a Beacon report is left in place. |
| `title` | `Cypress` | Header title. |
| `history` | `.beacon-history`, 30 runs | Pass `false` to skip history. |
| `categories` | assertion and timeout | `{ name, messageRegex?, stackRegex? }[]` matched against errors. |
| `scrub` | — | Array of `{ pattern, flags?, replacement? }`. Applied to errors, command steps, and text attachments. |
| `environment` | browser, Cypress version, OS | Extra key-values on the environment card. |
| `dashboard` | every card | `{ cards?, slowest? }`. `cards` is the dashboard order. |
| `links` | — | URL templates per annotation type. `{}` is the description. |
| `branding` | — | `{ logo?, accentColor? }`. Logo is svg, png, jpg, or webp, at most 64KB. |
| `coverage` | — | Path to an istanbul `coverage-summary.json`. |
| `editorLinks` | off | Record the project root so the report can open source files. |
| `watch` | off | Rewrite the report after each spec while the run is still going. |

An example spec is in [`examples/`](https://github.com/pradapjackie/beacon-cypress/tree/main/examples) on GitHub and in the `examples/` folder of the published package. `@cypress/grep` tags live on the test config, which Cypress does not include in `after:run`, so only tags written in the title (or a `tags` array on the test result) show on the report. Named `cy.screenshot('checkout-page')` images are recorded when the collector is on. A project's own `Cypress.Screenshot.defaults({ onAfterScreenshot })` still runs. `toCypressReport` builds the report data. The 0.1 name `toBeaconFixture` was removed in 0.2.0. See [CHANGELOG.md](./CHANGELOG.md). `scrub` flags always match every occurrence, so `flags: 'i'` still redacts the whole string.
