import css from './ui/report.styles';
import client from './ui/report.client';

/** One HTML file. Attachments stay beside it and load on file:// and over http. */
export function renderReportHtml(data: unknown): string {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Beacon Report</title>
  <!-- beacon-cypress-report -->
  <script>
    try {
      var stored = localStorage.getItem('beacon-theme');
      var dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', dark);
    } catch (e) {}
  </script>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>window.__REPORT__ = ${json};</script>
  <script>${client}</script>
</body>
</html>
`;
}
