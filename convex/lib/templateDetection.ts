/**
 * Extracts unique {{variableName}} patterns from a prompt text.
 * Handles: duplicate variables (deduped), whitespace in braces (trimmed).
 * Ignores block syntax ({{#if}}, {{>partial}}, etc.).
 */
export function detectVariables(text: string): string[] {
  const pattern = /\{\{(\w[\w\s]*?\w|\w)\}\}/g;
  const vars = new Set<string>();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]!.trim();
    // Skip Mustache-style block syntax
    if (/^[#/!>^]/.test(name)) continue;
    vars.add(name);
  }
  return [...vars];
}
