/**
 * JSON for embedding in a classic `<script>` block or a `.js` chunk.
 * `JSON.stringify` leaves `<`, U+2028, and U+2029 intact, so a test title or
 * source snippet containing `</script>` closes the surrounding script tag.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
