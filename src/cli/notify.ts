import { readManifest } from './read-report';
import { summarize } from './summarize';

export type NotifyFormat = 'plain' | 'slack' | 'teams';

interface Counts {
  total: number;
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}

async function readCounts(reportDir: string): Promise<{ counts: Counts; title?: string }> {
  const raw = await readManifest(reportDir);
  const manifest = JSON.parse(raw.slice(raw.indexOf(', ') + 2, raw.lastIndexOf(');'))) as {
    counts: Counts;
    ui?: { title?: string };
  };
  return { counts: manifest.counts, title: manifest.ui?.title };
}

/**
 * Posts the report digest to an incoming webhook. `plain` sends `{"text"}`
 * (works everywhere); `slack` sends Block Kit blocks; `teams` sends a
 * MessageCard with a status theme color.
 */
/** GitHub-flavored summarize() output, rewritten for Slack mrkdwn. */
export function toSlackMrkdwn(markdown: string, reportUrl?: string): string {
  const body = markdown
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^\|.*\|$/gm, (line) => {
      if (/^\|?\s*:?-{3,}/.test(line)) return '';
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      return cells.length > 0 ? `• ${cells.join(' — ')}` : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const link = reportUrl ? `\n<${reportUrl}|Open the report>` : '';
  const room = 2900 - link.length;
  const clipped = body.length > room ? `${body.slice(0, room).trimEnd()}…` : body;
  return `${clipped}${link}`;
}

export async function notify(
  reportDir: string,
  webhookUrl: string,
  format: NotifyFormat = 'plain',
  reportUrl?: string,
): Promise<void> {
  const markdown = await summarize(reportDir);
  const text = markdown.length > 3500 ? `${markdown.slice(0, 3500)}\n…(truncated)` : markdown;

  let body: unknown = { text };
  if (format !== 'plain') {
    const { counts, title } = await readCounts(reportDir);
    const passed = counts.unexpected === 0;
    const heading = `${passed ? '✅' : '❌'} ${title ?? 'Test run'}: ${counts.expected + counts.flaky}/${counts.total} passed`;
    const fields = [
      `Failed: ${counts.unexpected}`,
      `Flaky: ${counts.flaky}`,
      `Skipped: ${counts.skipped}`,
    ];
    const digest = toSlackMrkdwn(markdown, reportUrl);
    if (format === 'slack') {
      body = {
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: heading, emoji: true } },
          {
            type: 'section',
            fields: fields.map((f) => ({ type: 'mrkdwn', text: `*${f.replace(': ', ':* ')}` })),
          },
          { type: 'section', text: { type: 'mrkdwn', text: digest } },
        ],
      };
    } else {
      body = {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: passed ? '059669' : 'dc2626',
        summary: heading,
        title: heading,
        text: fields.join(' · '),
        sections: [{ text: digest }],
      };
    }
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status} ${response.statusText}`);
  }
}
