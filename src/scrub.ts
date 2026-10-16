export interface ScrubRule {
  pattern: string;
  flags?: string;
  replacement?: string;
}

/** Beacon scrub rules. An object, or a rule without a string pattern, is ignored. */
export function compileScrub(scrub: unknown): {
  rules: ScrubRule[] | undefined;
  apply: (text: string) => string;
} {
  if (scrub == null) return { rules: undefined, apply: (text) => text };
  if (!Array.isArray(scrub)) {
    console.warn(
      '[beacon] scrub must be an array of { pattern, flags?, replacement? }. The value was ignored.',
    );
    return { rules: undefined, apply: (text) => text };
  }
  const compiled: Array<{ re: RegExp; to: string }> = [];
  const rules: ScrubRule[] = [];
  for (const rule of scrub) {
    if (!rule || typeof rule !== 'object' || typeof (rule as ScrubRule).pattern !== 'string') {
      console.warn('[beacon] Each scrub rule needs a string pattern. One rule was ignored.');
      continue;
    }
    const entry = rule as ScrubRule;
    const flags = withGlobal(entry.flags);
    try {
      compiled.push({
        re: new RegExp(entry.pattern, flags),
        to: entry.replacement ?? '[redacted]',
      });
      rules.push({ ...entry, flags });
    } catch {
      console.warn(`[beacon] Invalid scrub pattern ignored: ${entry.pattern}`);
    }
  }
  return {
    rules,
    apply: (text) => compiled.reduce((acc, rule) => acc.replace(rule.re, rule.to), text),
  };
}

/** `flags: 'i'` would otherwise stop after the first match. */
function withGlobal(flags: string | undefined): string {
  const base = flags ?? '';
  return base.includes('g') ? base : `${base}g`;
}
