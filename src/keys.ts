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
