/// <reference types="vite/client" />
import { expect, test, describe } from "vitest";
import {
  validateOptimizerOutput,
  type OptimizerInput,
} from "../lib/optimizerValidation";

const baseInput: OptimizerInput = {
  currentSystemMessage: "You are a helpful assistant.",
  currentUserTemplate: "Hello {{name}}, please help with {{task}}.",
  projectVariables: [
    { name: "name", required: true },
    { name: "task", required: true },
    { name: "context", required: false },
  ],
  outputFeedback: [
    { blindLabel: "A", highlightedText: "too formal", comment: "Make it casual" },
  ],
  promptFeedback: [
    {
      targetField: "system_message",
      highlightedText: "helpful",
      comment: "Be more specific about the domain",
    },
  ],
  metaContext: [{ question: "What domain?", answer: "Customer support" }],
};

function validOutput() {
  return JSON.stringify({
    newSystemMessage: "You are a friendly customer support assistant.",
    newUserTemplate: "Hey {{name}}, I need help with {{task}}.",
    changesSummary: "- Made greeting more casual\n- Updated system message tone",
    changesReasoning:
      "Output A was flagged as too formal. Updated the user template greeting and adjusted the system_message to be more domain-specific per feedback.",
  });
}

describe("validateOptimizerOutput", () => {
  test("happy path — valid output passes all checks", () => {
    const result = validateOptimizerOutput(validOutput(), baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.newUserTemplate).toBe(
        "Hey {{name}}, I need help with {{task}}.",
      );
      expect(result.output.changesSummary).toContain("casual");
    }
  });

  test("check 1: malformed JSON", () => {
    const result = validateOptimizerOutput("not json at all", baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("malformed output");
    }
  });

  test("check 1: JSON array instead of object", () => {
    const result = validateOptimizerOutput("[1, 2, 3]", baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("malformed output");
    }
  });

  test("check 2: missing newUserTemplate", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "Updated",
        changesSummary: "Changed stuff",
        changesReasoning: "Because Output A said so",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("incomplete response");
    }
  });

  test("check 2: empty changesSummary", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "Updated",
        newUserTemplate: "Hey {{name}}, {{task}}.",
        changesSummary: "",
        changesReasoning: "Because Output A said so",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("incomplete response");
    }
  });

  test("check 3: unknown variable in template", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: null,
        newUserTemplate: "Hello {{name}}, {{unknown_var}} and {{task}}.",
        changesSummary: "- Added unknown var",
        changesReasoning: "Output A needed more context in user_template",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown variable");
      expect(result.error).toContain("unknown_var");
    }
  });

  test("check 4: unsupported template syntax", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: null,
        newUserTemplate: "Hello {{name}}, {{#if task}}do {{task}}{{/if}}.",
        changesSummary: "- Added conditional",
        changesReasoning: "Output A needed conditional logic in system_message",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsupported template syntax");
    }
  });

  test("check 5: dropped required variable", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: null,
        newUserTemplate: "Hello {{name}}, how can I help?",
        changesSummary: "- Simplified template",
        changesReasoning: "Output A was too complex. Removed task from user_template.",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("dropped a required variable");
      expect(result.error).toContain("task");
    }
  });

  test("check 5: required variable in system message is OK", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage:
          "You handle {{task}} for customers. You are a customer support agent.",
        newUserTemplate: "Hello {{name}}, how can I help?",
        changesSummary: "- Moved task to system message",
        changesReasoning:
          "Output A feedback suggested the system_message should specify the task context.",
      }),
      baseInput,
    );
    // task is in system message, name is in template — both required vars present
    expect(result.ok).toBe(true);
  });

  test("check 6: no-op change", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "You are a helpful assistant.",
        newUserTemplate: "Hello {{name}}, please help with {{task}}.",
        changesSummary: "- No changes needed",
        changesReasoning: "Output A was already good, system_message is fine",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("same prompt");
    }
  });

  test("check 6: null vs undefined system message counts as same", () => {
    const noSystemInput = {
      ...baseInput,
      currentSystemMessage: null,
    };
    const result = validateOptimizerOutput(
      JSON.stringify({
        newUserTemplate: "Hello {{name}}, please help with {{task}}.",
        changesSummary: "- No changes needed",
        changesReasoning: "Output A was already good, system_message is fine",
      }),
      noSystemInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("same prompt");
    }
  });

  test("check 7: reasoning without citation", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "You are a customer support agent.",
        newUserTemplate: "Hey {{name}}, {{task}} please.",
        changesSummary: "- Updated tone",
        changesReasoning:
          "The prompt was too formal and needed a friendlier tone to improve responses.",
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not grounded");
    }
  });

  test("check 7: reasoning with blind label citation passes", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "You are a customer support agent.",
        newUserTemplate: "Hey {{name}}, {{task}} please.",
        changesSummary: "- Updated tone",
        changesReasoning:
          "Based on Output A feedback about formality, the greeting was made casual.",
      }),
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  test("check 7: reasoning with field name citation passes", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "You are a customer support agent.",
        newUserTemplate: "Hey {{name}}, {{task}} please.",
        changesSummary: "- Updated system message",
        changesReasoning:
          "The system message was updated to be more specific about the domain.",
      }),
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  test("newSystemMessage as null is valid", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: null,
        newUserTemplate: "Hey {{name}}, {{task}} please.",
        changesSummary: "- Removed system message",
        changesReasoning:
          "Output B feedback suggested the system_message was redundant.",
      }),
      { ...baseInput, currentSystemMessage: "Old system message" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.newSystemMessage).toBeNull();
    }
  });

  test("optional variable can be dropped", () => {
    const result = validateOptimizerOutput(
      JSON.stringify({
        newSystemMessage: "Updated assistant",
        newUserTemplate: "Hello {{name}}, {{task}}.",
        changesSummary: "- Simplified",
        changesReasoning:
          "Output C was too long, simplified by removing optional context from user_template.",
      }),
      baseInput,
    );
    // context is optional, so dropping it is fine
    expect(result.ok).toBe(true);
  });
});
