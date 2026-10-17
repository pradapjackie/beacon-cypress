/** Cypress does not record a source line. Hide the placeholder. */
export function specAt(file: string, line: number | undefined): string {
  return line && line > 0 ? `${file}:${line}` : file;
}
