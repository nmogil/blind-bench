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

/**
 * Return the set of {{variable}} names referenced anywhere across the given
 * template strings. Unsupported block syntax still throws via validateTemplate
 * semantics — use this after a successful template save, not before.
 */
export function collectReferencedVariables(templates: string[]): Set<string> {
  const pattern = /(?<!\\)\{\{([^}]+)\}\}/g;
  const out = new Set<string>();
  for (const template of templates) {
    if (!template) continue;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(template)) !== null) {
      const inner = match[1]!.trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
        out.add(inner);
      }
    }
  }
  return out;
}

/**
 * M21.3: Image variables may only appear in user-role messages. OpenRouter
 * normalization across providers is inconsistent for system/assistant images,
 * and Anthropic's native API rejects them outright — so we lock down to the
 * lowest common denominator. Throws on the first violation it finds.
 */
export function validateImageVariablePlacement(
  messages: ReadonlyArray<{ role: string; content?: string }>,
  imageVariableNames: ReadonlySet<string>,
): void {
  if (imageVariableNames.size === 0) return;
  const pattern = /(?<!\\)\{\{([^}]+)\}\}/g;
  for (const msg of messages) {
    if (msg.role === "user") continue;
    const content = msg.content ?? "";
    if (!content) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1]!.trim();
      if (imageVariableNames.has(name)) {
        throw new Error(
          `Image variable {{${name}}} cannot appear in ${msg.role} messages — image variables are user-message-only`,
        );
      }
    }
  }
}
