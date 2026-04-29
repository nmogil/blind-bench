import { validateTemplate } from "./templateValidation";

export interface OptimizerInput {
  currentSystemMessage: string | null;
  currentUserTemplate: string;
  projectVariables: Array<{
    name: string;
    description?: string;
    required: boolean;
    /** M21.8: variable kind. Absent = "text" (legacy). Image variables are
     * immutable scaffolding — see image-token preservation rules below. */
    type?: "text" | "image";
  }>;
  outputFeedback: Array<{
    blindLabel: string;
    highlightedText: string;
    comment: string;
    model?: string;
    temperature?: number;
    /** M27.4: conventional-comments-style label (suggestion / issue / praise / question / nitpick / thought). */
    label?: string;
  }>;
  overallNotes: Array<{
    blindLabel: string;
    comment: string;
    model?: string;
    temperature?: number;
  }>;
  ratingDistribution: Array<{
    blindLabel: string;
    best: number;
    acceptable: number;
    weak: number;
  }>;
  headToHead: Array<{
    winnerBlindLabel: string;
    loserBlindLabel: string | null;
    tie: boolean;
    reasonTags: string[];
  }>;
  promptFeedback: Array<{
    targetField: "system_message" | "user_message_template";
    highlightedText: string;
    comment: string;
    /** M27.4: conventional-comments-style label (suggestion / issue / praise / question / nitpick / thought). */
    label?: string;
  }>;
  metaContext: Array<{ question: string; answer: string }>;
}

export interface OptimizerOutput {
  newSystemMessage: string | null;
  newUserTemplate: string;
  changesSummary: string;
  changesReasoning: string;
  /** M27.5: optional per-change rationales used by inline optimizer markers. */
  changes?: Array<{
    targetField: "system_message" | "user_message_template";
    range: { from: number; to: number };
    rationale: string;
  }>;
}

/**
 * `errorKind: "image_var"` is the only retryable failure today. The optimizer
 * sometimes paraphrases or relocates image tokens despite Constraint 9, and a
 * single corrective re-prompt usually fixes it. Other validation errors are
 * structural and non-retryable.
 */
type ValidationErrorKind = "image_var" | "other";

type ValidationResult =
  | { ok: true; output: OptimizerOutput }
  | { ok: false; error: string; errorKind: ValidationErrorKind };

const fail = (
  error: string,
  errorKind: ValidationErrorKind = "other",
): ValidationResult => ({ ok: false, error, errorKind });

/**
 * Validates raw JSON from the optimizer LLM against all 7 failure modes.
 * Returns a validated OptimizerOutput or an error message string.
 */
export function validateOptimizerOutput(
  rawJson: string,
  input: OptimizerInput,
): ValidationResult {
  // 1. JSON parse
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return fail(
      "The optimizer returned malformed output. Try again or adjust the meta-prompt.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(
      "The optimizer returned malformed output. Try again or adjust the meta-prompt.",
    );
  }

  // 2. Missing required fields
  const { newUserTemplate, changesSummary, changesReasoning, newSystemMessage } =
    parsed as Record<string, unknown>;

  if (
    typeof newUserTemplate !== "string" ||
    newUserTemplate.trim() === "" ||
    typeof changesSummary !== "string" ||
    changesSummary.trim() === "" ||
    typeof changesReasoning !== "string" ||
    changesReasoning.trim() === ""
  ) {
    return fail("The optimizer returned an incomplete response.");
  }

  // newSystemMessage must be string or null/undefined
  if (
    newSystemMessage !== null &&
    newSystemMessage !== undefined &&
    typeof newSystemMessage !== "string"
  ) {
    return fail("The optimizer returned an incomplete response.");
  }

  const resolvedSystemMessage =
    typeof newSystemMessage === "string" ? newSystemMessage : null;

  // M21.8: image variables are immutable scaffolding (Constraint 9). Checked
  // before unknown-variable / required-variable so that a renamed or dropped
  // image token surfaces as a retryable image_var failure rather than the
  // generic non-retryable error those checks would emit.
  const imageVarNames = new Set(
    input.projectVariables.filter((v) => v.type === "image").map((v) => v.name),
  );
  for (const name of imageVarNames) {
    const pattern = `{{${name}}}`;
    if (resolvedSystemMessage?.includes(pattern)) {
      return fail(
        `The optimizer placed image variable \`{{${name}}}\` in the system message. Image tokens may only appear in the user template.`,
        "image_var",
      );
    }
    const inOldTemplate = input.currentUserTemplate.includes(pattern);
    const inNewTemplate = (newUserTemplate as string).includes(pattern);
    if (inOldTemplate && !inNewTemplate) {
      return fail(
        `The optimizer dropped or renamed image variable \`{{${name}}}\`. Image tokens are immutable scaffolding — they must be preserved verbatim in the user template.`,
        "image_var",
      );
    }
  }

  const variableNames = input.projectVariables.map((v) => v.name);

  // 3 & 4. Unknown variable / Unsupported template syntax (via validateTemplate)
  try {
    const unknownFromUser = validateTemplate(newUserTemplate as string, variableNames);
    const unknownFromSystem = resolvedSystemMessage
      ? validateTemplate(resolvedSystemMessage, variableNames)
      : [];
    const allUnknown = [...new Set([...unknownFromUser, ...unknownFromSystem])];
    if (allUnknown.length > 0) {
      return fail(
        `The optimizer referenced unknown variable \`{{${allUnknown[0]}}}\`.`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Unsupported template syntax") {
      return fail("The optimizer used unsupported template syntax.");
    }
    return fail(msg);
  }

  // 5. Dropped required variable. Skip image vars — handled earlier with a
  // stricter (and retryable) check.
  const requiredVars = input.projectVariables.filter(
    (v) => v.required && v.type !== "image",
  );
  for (const v of requiredVars) {
    const pattern = `{{${v.name}}}`;
    const inTemplate = (newUserTemplate as string).includes(pattern);
    const inSystem = resolvedSystemMessage?.includes(pattern) ?? false;
    if (!inTemplate && !inSystem) {
      return fail(
        `The optimizer dropped a required variable (\`{{${v.name}}}\`).`,
      );
    }
  }

  // 6. No-op change
  const sameTemplate = newUserTemplate === input.currentUserTemplate;
  const sameSystem =
    (resolvedSystemMessage ?? null) === (input.currentSystemMessage ?? null);
  if (sameTemplate && sameSystem) {
    return fail("The optimizer returned the same prompt — nothing to review.");
  }

  // 7. Reasoning without citation
  const reasoning = changesReasoning as string;
  const hasCitation =
    /\b[A-E]\b/.test(reasoning) ||
    /\bOutput [A-E]\b/i.test(reasoning) ||
    /\bsystem[_ ]message\b/i.test(reasoning) ||
    /\buser[_ ](message[_ ])?template\b/i.test(reasoning);
  if (!hasCitation) {
    return fail(
      "The optimizer's reasoning was not grounded in specific feedback.",
    );
  }

  // 8. Optional structured changes (M27.5). If present and well-formed, pass
  // through with light sanitization (clamp ranges to the resulting text). If
  // malformed, drop the field — never fail the whole optimization on it.
  let validatedChanges: OptimizerOutput["changes"] | undefined;
  const rawChanges = (parsed as Record<string, unknown>).changes;
  if (Array.isArray(rawChanges)) {
    const collected: NonNullable<OptimizerOutput["changes"]> = [];
    for (const c of rawChanges) {
      if (typeof c !== "object" || c === null) continue;
      const entry = c as Record<string, unknown>;
      const targetField = entry.targetField;
      const range = entry.range;
      const rationale = entry.rationale;
      if (
        (targetField !== "system_message" &&
          targetField !== "user_message_template") ||
        typeof rationale !== "string" ||
        rationale.trim() === "" ||
        typeof range !== "object" ||
        range === null
      ) {
        continue;
      }
      const r = range as Record<string, unknown>;
      const from = typeof r.from === "number" ? r.from : NaN;
      const to = typeof r.to === "number" ? r.to : NaN;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
        continue;
      }
      const referenceText =
        targetField === "system_message"
          ? (resolvedSystemMessage ?? "")
          : (newUserTemplate as string);
      const clampedFrom = Math.min(from, referenceText.length);
      const clampedTo = Math.min(to, referenceText.length);
      collected.push({
        targetField,
        range: { from: clampedFrom, to: clampedTo },
        rationale: rationale.trim(),
      });
    }
    if (collected.length > 0) validatedChanges = collected;
  }

  return {
    ok: true,
    output: {
      newSystemMessage: resolvedSystemMessage,
      newUserTemplate: newUserTemplate as string,
      changesSummary: changesSummary as string,
      changesReasoning: reasoning,
      changes: validatedChanges,
    },
  };
}
