/**
 * Validates a prompt template string against a set of known variable names.
 *
 * Only `{{variableName}}` is allowed. Escaped `\{{literal}}` is skipped.
 * Block syntax (`{{#if}}`, `{{>partial}}`, `{{!comment}}`, etc.) throws.
 * Unknown variable names throw.
 */
export function validateTemplate(
  template: string,
  variables: string[],
): void {
  // Match all unescaped {{ ... }} sequences
  const pattern = /(?<!\\)\{\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(template)) !== null) {
    const inner = match[1]!.trim();

    // Check for unsupported Mustache-style block syntax
    if (/^[#/!>^]/.test(inner)) {
      throw new Error("Unsupported template syntax");
    }

    // Validate the variable name exists
    if (!variables.includes(inner)) {
      throw new Error(`Unknown variable \`{{${inner}}}\``);
    }
  }
}
