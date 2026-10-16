/** `${specRelative}::${titles}`. A repeated title in the same spec gets ` #2`, ` #3`, … */
export function commandKey(specRelative: string, title: string[], duplicate = 0): string {
  const base = `${specRelative}::${title.join(' > ')}`;
  return duplicate > 0 ? `${base} #${duplicate + 1}` : base;
}

export function duplicateIndex(seen: Map<string, number>, title: string[]): number {
  const base = title.join(' > ');
  const index = seen.get(base) ?? 0;
  seen.set(base, index + 1);
  return index;
}

/**
 * The duplicate counter moves only on the first try. Retries reuse that key,
 * so attempt 2 is not stored as a different test named `#2`.
 */
export function keyForAttempt(
  seen: Map<string, number>,
  specRelative: string,
  title: string[],
  retry: number,
): string {
  const titles = title.filter(Boolean);
  if (retry > 0) {
    const issued = seen.get(titles.join(' > ')) ?? 1;
    return commandKey(specRelative, titles, Math.max(0, issued - 1));
  }
  return commandKey(specRelative, titles, duplicateIndex(seen, titles));
}
