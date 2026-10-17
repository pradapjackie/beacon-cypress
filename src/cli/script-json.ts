/**
 * JSON for embedding in a classic `<script>` block.
 * Kept in sync with packages/reporter/src/script-json.ts — the CLI package
 * does not depend on the private shared workspace.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
