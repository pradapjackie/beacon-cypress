#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { serveReport } from './server';

const HELP = `beacon-cypress — Beacon report toolkit

Usage:
  beacon-cypress open [reportDir] [--port <n>]     Serve a generated report and print the URL
  beacon-cypress export [reportDir] [--out <file>] Bundle a report into one self-contained .html
                [--failures-only]                  (images inlined up to 10 MB; videos omitted)
                [--pdf]                            …or print the dashboard to a PDF
  beacon-cypress gate [reportDir] [--max-failed n] Exit non-zero when thresholds are violated
              [--max-flaky n]                      (no flags = fail on any unexpected failure)
              [--min-pass-rate pct]
  beacon-cypress summarize [reportDir] [--out <file>] Markdown digest (PR comments, AI agents)
  beacon-cypress convert [reportDir] --format junit|ctrf|csv [--out <file>]
  beacon-cypress quarantine [reportDir]            Same flaky list as the Flaky page (score ≥ 40)
              [--min-runs 3] [--grep-invert] [--fixme]
  beacon-cypress notify [reportDir] --webhook <url> Post the summary to a webhook
                [--format plain|slack|teams]
                [--url <report-url>]
  beacon-cypress diff <reportA> <reportB>          Compare two reports (new/fixed/regressed/slower)
  beacon-cypress archive <parentDir> [--out <file>] Index page over a directory of reports
  beacon-cypress history show [dir]                Print the retained run table (default .beacon-history)
  beacon-cypress history prune [dir] --retain <n>  Keep only the newest n runs
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'open': {
    const args = rest.filter((a) => !a.startsWith('--'));
    const portFlag = rest.indexOf('--port');
    const port = portFlag >= 0 ? Number(rest[portFlag + 1]) : 4173;
    if (Number.isNaN(port)) fail('Invalid --port value');
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    if (!existsSync(reportDir)) {
      fail(
        `Report directory not found: ${reportDir}\nRun your Playwright tests with the beacon-reporter reporter first.`,
      );
    }
    serveReport(reportDir, port);
    console.log(`Serving ${reportDir}`);
    console.log(`  ➜  http://localhost:${port}/`);
    console.log('Press Ctrl+C to stop.');
    break;
  }
  case 'generate':
  case 'merge':
    fail(
      `beacon-cypress ${command} is not available here.\nShard merge and recorded Playwright events stay in beacon-reporter.`,
    );
    break;
  case 'export': {
    const args = [...rest];
    const failuresOnly = args.includes('--failures-only');
    if (failuresOnly) args.splice(args.indexOf('--failures-only'), 1);
    const pdf = args.includes('--pdf');
    if (pdf) args.splice(args.indexOf('--pdf'), 1);
    let out = pdf ? 'beacon-report.pdf' : 'beacon-report.html';
    const outFlag = args.indexOf('--out');
    if (outFlag >= 0) {
      out = args[outFlag + 1] ?? out;
      args.splice(outFlag, 2);
    }
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    if (!existsSync(reportDir)) {
      fail(`Report directory not found: ${reportDir}`);
    }
    if (pdf) {
      try {
        const { exportPdf } = await import('./pdf');
        await exportPdf(reportDir, out);
        console.log(`PDF exported: ${path.resolve(out)}`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      break;
    }
    try {
      const { exportSingleFile } = await import('./export');
      const { bytes, inlinedAttachments } = await exportSingleFile(reportDir, out, {
        failuresOnly,
      });
      console.log(
        `Exported ${path.resolve(out)} (${(bytes / 1024 / 1024).toFixed(1)} MB, ${inlinedAttachments} attachments inlined${failuresOnly ? ', failures only' : ''})`,
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'gate': {
    const args = [...rest];
    const flag = (name: string): number | undefined => {
      const at = args.indexOf(name);
      if (at < 0) return undefined;
      const value = Number(args[at + 1]);
      args.splice(at, 2);
      if (Number.isNaN(value)) fail(`Invalid value for ${name}`);
      return value;
    };
    const maxFailed = flag('--max-failed');
    const maxFlaky = flag('--max-flaky');
    const minPassRate = flag('--min-pass-rate');
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    try {
      const { gate } = await import('./gate');
      const result = await gate(reportDir, { maxFailed, maxFlaky, minPassRate });
      const c = result.counts;
      console.log(
        `Gate: ${c.total} tests · ${c.unexpected} failed · ${c.flaky} flaky · ${c.skipped} skipped`,
      );
      if (!result.ok) {
        fail(`Gate FAILED: ${result.violations.join('; ')}`);
      }
      console.log('Gate PASSED');
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'summarize': {
    const args = rest.filter((a) => a !== '--html');
    let out: string | undefined;
    const outFlag = args.indexOf('--out');
    if (outFlag >= 0) {
      out = args[outFlag + 1];
      args.splice(outFlag, 2);
    }
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    try {
      const wantHtml = rest.includes('--html');
      const { summarize, summaryToHtml } = await import('./summarize');
      const rendered = wantHtml
        ? summaryToHtml(await summarize(reportDir))
        : await summarize(reportDir);
      const markdown = rendered;
      if (out) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(out, markdown, 'utf8');
        console.log(`Summary written: ${path.resolve(out)}`);
      } else {
        console.log(markdown);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'convert': {
    const args = [...rest];
    const formatFlag = args.indexOf('--format');
    const format = formatFlag >= 0 ? args[formatFlag + 1] : undefined;
    if (formatFlag >= 0) args.splice(formatFlag, 2);
    if (format !== 'junit' && format !== 'ctrf' && format !== 'csv') {
      fail('beacon convert requires --format junit|ctrf|csv');
    }
    let out = format === 'junit' ? 'results.xml' : format === 'ctrf' ? 'ctrf.json' : 'results.csv';
    const outFlag = args.indexOf('--out');
    if (outFlag >= 0) {
      out = args[outFlag + 1] ?? out;
      args.splice(outFlag, 2);
    }
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    try {
      const { convert } = await import('./convert');
      const { tests } = await convert(reportDir, format, out);
      console.log(`Converted ${tests} tests → ${path.resolve(out)} (${format})`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'quarantine': {
    const args = [...rest];
    const grepInvert = args.includes('--grep-invert');
    if (grepInvert) args.splice(args.indexOf('--grep-invert'), 1);
    const fixme = args.includes('--fixme');
    if (fixme) args.splice(args.indexOf('--fixme'), 1);
    const strFlag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      if (at < 0) return undefined;
      const value = args[at + 1];
      args.splice(at, 2);
      return value;
    };
    strFlag('--history');
    strFlag('--min-rate');
    const minRuns = Number(strFlag('--min-runs') ?? 3);
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    try {
      const { quarantineCandidates, toGrepInvert } = await import('./quarantine');
      const candidates = await quarantineCandidates(reportDir, { minRuns });
      if (grepInvert) {
        console.log(toGrepInvert(candidates));
      } else if (fixme) {
        const { toFixmeSuggestions } = await import('./quarantine');
        console.log(
          candidates.length === 0 ? 'No quarantine candidates.' : toFixmeSuggestions(candidates),
        );
      } else if (candidates.length === 0) {
        console.log('No quarantine candidates — nothing flaky enough.');
      } else {
        for (const c of candidates) {
          console.log(`${c.title} (${c.projectName}) — failing ${c.failures}/${c.runs} runs`);
        }
        console.log('\nUse --grep-invert to emit a title regex you can skip in Cypress.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'archive': {
    const args = [...rest];
    let out: string | undefined;
    const outFlag = args.indexOf('--out');
    if (outFlag >= 0) {
      out = args[outFlag + 1];
      args.splice(outFlag, 2);
    }
    const parentDir = args[0];
    if (!parentDir) fail('beacon archive requires a directory of reports');
    try {
      const { buildArchive } = await import('./archive');
      const target = out ?? path.join(parentDir, 'index.html');
      const count = await buildArchive(path.resolve(parentDir), path.resolve(target));
      console.log(`Archive index with ${count} reports → ${path.resolve(target)}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'notify': {
    const args = [...rest];
    const hookFlag = args.indexOf('--webhook');
    const webhook = hookFlag >= 0 ? args[hookFlag + 1] : undefined;
    if (hookFlag >= 0) args.splice(hookFlag, 2);
    if (!webhook) fail('beacon notify requires --webhook <url>');
    const formatFlag = args.indexOf('--format');
    const format = formatFlag >= 0 ? args[formatFlag + 1] : 'plain';
    if (formatFlag >= 0) args.splice(formatFlag, 2);
    const urlFlag = args.indexOf('--url');
    const reportUrl = urlFlag >= 0 ? args[urlFlag + 1] : process.env.BEACON_REPORT_URL;
    if (urlFlag >= 0) args.splice(urlFlag, 2);
    if (format !== 'plain' && format !== 'slack' && format !== 'teams') {
      fail('beacon notify --format must be plain, slack or teams');
    }
    const reportDir = path.resolve(args[0] ?? 'beacon-report');
    try {
      const { notify } = await import('./notify');
      await notify(reportDir, webhook, format, reportUrl);
      console.log(`Summary posted to webhook (${format}).`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'diff': {
    const [dirA, dirB] = rest.filter((a) => !a.startsWith('--'));
    if (!dirA || !dirB) fail('beacon diff requires two report directories');
    try {
      const { diffReports, printDiff } = await import('./diff');
      console.log(printDiff(await diffReports(path.resolve(dirA), path.resolve(dirB))));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case 'history': {
    const [sub, ...historyArgs] = rest;
    const args = [...historyArgs];
    const retainFlag = args.indexOf('--retain');
    const retain = retainFlag >= 0 ? Number(args[retainFlag + 1]) : undefined;
    if (retainFlag >= 0) args.splice(retainFlag, 2);
    const dir = path.resolve(args[0] ?? '.beacon-history');
    try {
      const { listRuns, pruneRuns, renderRuns } = await import('./history-cmd');
      if (sub === 'show' || sub === undefined) {
        console.log(renderRuns(await listRuns(dir)));
      } else if (sub === 'prune') {
        if (retain === undefined || Number.isNaN(retain) || retain < 1) {
          fail('beacon history prune requires --retain <n>');
        }
        const removed = await pruneRuns(dir, retain);
        console.log(`Pruned ${removed} runs — ${retain} retained in ${dir}`);
      } else {
        fail(`Unknown history subcommand "${sub}" — use show or prune`);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    break;
  }
  case '--help':
  case '-h':
  case undefined:
    console.log(HELP);
    break;
  default:
    fail(`Unknown command "${command}"\n\n${HELP}`);
}
