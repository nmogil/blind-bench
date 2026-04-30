export type PromptMessageRole = "system" | "developer" | "user" | "assistant";

export type PromptMessage =
  | {
      id: string;
      role: "system" | "developer";
      content: string;
      format?: "plain" | "markdown";
    }
  | {
      id: string;
      role: "user";
      content: string;
      format?: "plain" | "markdown";
    }
  | {
      id: string;
      role: "assistant";
      content?: string;
    };

export function genMessageId(): string {
  return crypto.randomUUID();
}

/**
 * Mirror of convex/lib/messages.ts readMessages — prefers the version's
 * authored messages[] and falls back to synthesizing from legacy fields so
 * pre-M18 versions render correctly before the backfill has run.
 */
export function readVersionMessages(version: {
  messages?: PromptMessage[];
  systemMessage?: string;
  userMessageTemplate?: string;
  systemMessageFormat?: "plain" | "markdown";
  userMessageTemplateFormat?: "plain" | "markdown";
}): PromptMessage[] {
  if (version.messages && version.messages.length > 0) {
    return version.messages;
  }
  const out: PromptMessage[] = [];
  if (version.systemMessage) {
    out.push({
      id: genMessageId(),
      role: "system",
      content: version.systemMessage,
      format: version.systemMessageFormat,
    });
  }
  out.push({
    id: genMessageId(),
    role: "user",
    content: version.userMessageTemplate ?? "",
    format: version.userMessageTemplateFormat,
  });
  return out;
}

export function getMessageText(m: PromptMessage): string {
  return m.role === "assistant" ? (m.content ?? "") : m.content;
}

export function roleLabel(role: PromptMessageRole): string {
  switch (role) {
    case "system":
      return "System";
    case "developer":
      return "Developer";
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
  }
}

export function rolePlaceholder(role: PromptMessageRole): string {
  switch (role) {
    case "system":
      return "You are a helpful assistant...";
    case "developer":
      return "Instructions the model should prioritize over user input...";
    case "user":
      return "Translate: {{text}}";
    case "assistant":
      return "Prior assistant turn (optional — useful for few-shot examples)";
  }
}
