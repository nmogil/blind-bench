import { useCallback, useRef } from "react";

export interface PersistedRunConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  runMode: "uniform" | "mix";
  slotConfigs?: Array<{ label: string; model: string; temperature: number }>;
}

const STORAGE_KEY_PREFIX = "bb:runConfig:";

function loadConfig(projectId: string): PersistedRunConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Basic shape validation
    if (
      typeof parsed.model !== "string" ||
      typeof parsed.temperature !== "number" ||
      typeof parsed.maxTokens !== "number" ||
      (parsed.runMode !== "uniform" && parsed.runMode !== "mix")
    ) {
      return null;
    }
    return parsed as PersistedRunConfig;
  } catch {
    return null;
  }
}

/**
 * Persists run configuration (model, temperature, etc.) per project in localStorage.
 * Returns the last-used config and a save function to call after successful execution.
 */
export function usePersistedRunConfig(projectId: string): {
  initial: PersistedRunConfig | null;
  save: (config: PersistedRunConfig) => void;
} {
  const initialRef = useRef(loadConfig(projectId));

  const save = useCallback(
    (config: PersistedRunConfig) => {
      try {
        localStorage.setItem(
          STORAGE_KEY_PREFIX + projectId,
          JSON.stringify(config),
        );
      } catch {
        // localStorage full or unavailable — silently ignore
      }
    },
    [projectId],
  );

  return { initial: initialRef.current, save };
}
