import { validateTemplate } from "./templateValidation";

export interface OptimizerInput {
  currentSystemMessage: string | null;
  currentUserTemplate: string;
  projectVariables: Array<{
    name: string;
    description?: string;
    required: boolean;
  }>;
  outputFeedback: Array<{
    blindLabel: string;
    highlightedText: string;
    comment: string;
    model?: string;
    temperature?: number;
  }>;
  promptFeedback: Array<{
    targetField: "system_message" | "user_message_template";
    highlightedText: string;
    comment: string;
  }>;
  metaContext: Array<{ question: string; answer: string }>;
}

export interface OptimizerOutput {
  newSystemMessage: string | null;
  newUserTemplate: string;
  changesSummary: string;
  changesReasoning: string;
}

type ValidationResult =
  | { ok: true; output: OptimizerOutput }
  | { ok: false; error: string };

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
    return {
      ok: false,
      error:
        "The optimizer returned malformed output. Try again or adjust the meta-prompt.",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        "The optimizer returned malformed output. Try again or adjust the meta-prompt.",
    };
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
    return {
      ok: false,
      error: "The optimizer returned an incomplete response.",
    };
  }

  // newSystemMessage must be string or null/undefined
  if (
    newSystemMessage !== null &&
    newSystemMessage !== undefined &&
    typeof newSystemMessage !== "string"
  ) {
    return {
      ok: false,
      error: "The optimizer returned an incomplete response.",
    };
  }

  const resolvedSystemMessage =
    typeof newSystemMessage === "string" ? newSystemMessage : null;

  const variableNames = input.projectVariables.map((v) => v.name);

  // 3 & 4. Unknown variable / Unsupported template syntax (via validateTemplate)
  try {
    const unknownFromUser = validateTemplate(newUserTemplate as string, variableNames);
    const unknownFromSystem = resolvedSystemMessage
      ? validateTemplate(resolvedSystemMessage, variableNames)
      : [];
    const allUnknown = [...new Set([...unknownFromUser, ...unknownFromSystem])];
    if (allUnknown.length > 0) {
      return {
        ok: false,
        error: `The optimizer referenced unknown variable \`{{${allUnknown[0]}}}\`.`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Unsupported template syntax") {
      return {
        ok: false,
        error: "The optimizer used unsupported template syntax.",
      };
    }
    return { ok: false, error: msg };
  }

  // 5. Dropped required variable
  const requiredVars = input.projectVariables.filter((v) => v.required);
  for (const v of requiredVars) {
    const pattern = `{{${v.name}}}`;
    const inTemplate = (newUserTemplate as string).includes(pattern);
    const inSystem = resolvedSystemMessage?.includes(pattern) ?? false;
    if (!inTemplate && !inSystem) {
      return {
        ok: false,
        error: `The optimizer dropped a required variable (\`{{${v.name}}}\`).`,
      };
    }
  }

  // 6. No-op change
  const sameTemplate = newUserTemplate === input.currentUserTemplate;
  const sameSystem =
    (resolvedSystemMessage ?? null) === (input.currentSystemMessage ?? null);
  if (sameTemplate && sameSystem) {
    return {
      ok: false,
      error: "The optimizer returned the same prompt — nothing to review.",
    };
  }

  // 7. Reasoning without citation
  const reasoning = changesReasoning as string;
  const hasCitation =
    /\b[A-E]\b/.test(reasoning) ||
    /\bOutput [A-E]\b/i.test(reasoning) ||
    /\bsystem[_ ]message\b/i.test(reasoning) ||
    /\buser[_ ](message[_ ])?template\b/i.test(reasoning);
  if (!hasCitation) {
    return {
      ok: false,
      error:
        "The optimizer's reasoning was not grounded in specific feedback.",
    };
  }

  return {
    ok: true,
    output: {
      newSystemMessage: resolvedSystemMessage,
      newUserTemplate: newUserTemplate as string,
      changesSummary: changesSummary as string,
      changesReasoning: reasoning,
    },
  };
}
