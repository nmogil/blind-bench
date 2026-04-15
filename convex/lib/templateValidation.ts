/**
 * Validates a prompt template string against a set of known variable names.
 *
 * Only `{{variableName}}` is allowed. Escaped `\{{literal}}` is skipped.
 * Block syntax (`{{#if}}`, `{{>partial}}`, `{{!comment}}`, etc.) throws.
 * Returns an array of unknown variable names (empty if all are known).
 */
export function validateTemplate(
  template: string,
  variables: string[],
): string[] {
  const pattern = /(?<!\\)\{\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;
  const unknownVars: string[] = [];

  while ((match = pattern.exec(template)) !== null) {
    const inner = match[1]!.trim();

    // Check for unsupported Mustache-style block syntax
    if (/^[#/!>^]/.test(inner)) {
      throw new Error("Unsupported template syntax");
    }

    // Collect unknown variable names (valid identifiers only)
    if (!variables.includes(inner) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
      unknownVars.push(inner);
    }
  }

  return unknownVars;
}
