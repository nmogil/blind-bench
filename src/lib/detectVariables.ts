/**
 * Client-side variable detection from prompt text.
 * Mirrors convex/lib/templateDetection.ts for real-time preview.
 */
export function detectVariables(text: string): string[] {
  const pattern = /\{\{(\w[\w\s]*?\w|\w)\}\}/g;
  const vars = new Set<string>();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]!.trim();
    if (/^[#/!>^]/.test(name)) continue;
    vars.add(name);
  }
  return [...vars];
}
