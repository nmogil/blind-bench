import { Doc } from "../_generated/dataModel";

export interface SlotConfig {
  label: string;
  model: string;
  temperature: number;
}

const LABELS = ["A", "B", "C", "D", "E"];

/**
 * Returns an array of blind labels for a given slot count (1-5).
 */
export function getBlindLabels(count: number): string[] {
  if (count < 1 || count > 5) {
    throw new Error("Slot count must be between 1 and 5");
  }
  return LABELS.slice(0, count);
}

/**
 * Resolves the effective model and temperature for a given output.
 * Output-level values take precedence over run-level defaults.
 */
export function resolveOutputConfig(
  run: Pick<Doc<"promptRuns">, "model" | "temperature">,
  output: Pick<Doc<"runOutputs">, "model" | "temperature">,
): { model: string; temperature: number } {
  return {
    model: output.model ?? run.model,
    temperature: output.temperature ?? run.temperature,
  };
}

/**
 * Validates an array of slot configurations for a mix-mode run.
 * Throws a user-facing error message on validation failure.
 */
export function validateSlotConfigs(configs: SlotConfig[]): void {
  if (configs.length < 2 || configs.length > 5) {
    throw new Error("Slot count must be between 2 and 5");
  }
  const expectedLabels = getBlindLabels(configs.length);
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]!;
    if (config.label !== expectedLabels[i]) {
      throw new Error(
        `Slot ${i} has label "${config.label}", expected "${expectedLabels[i]}"`,
      );
    }
    if (!config.model || config.model.trim() === "") {
      throw new Error(`Slot ${config.label} must have a model selected`);
    }
    if (config.temperature < 0 || config.temperature > 2) {
      throw new Error(
        `Slot ${config.label} temperature must be between 0 and 2`,
      );
    }
  }
}
