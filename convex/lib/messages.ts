import { v } from "convex/values";

// M18: Canonical messages[] discriminated union for authored prompt versions.
// The schema mirrors this shape; keep them in sync.

export const messageFormatValidator = v.optional(
  v.union(v.literal("plain"), v.literal("markdown")),
);

export const messageValidator = v.union(
  v.object({
    id: v.string(),
    role: v.union(v.literal("system"), v.literal("developer")),
    content: v.string(),
    format: messageFormatValidator,
  }),
  v.object({
    id: v.string(),
    role: v.literal("user"),
    content: v.string(),
    format: messageFormatValidator,
  }),
  v.object({
    id: v.string(),
    role: v.literal("assistant"),
    content: v.optional(v.string()),
  }),
);

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

/**
 * Reject a messages[] payload if:
 *  - any id is empty,
 *  - two messages share the same id,
 *  - no user message is present (we require at least one to save).
 */
export function validateMessages(messages: PromptMessage[]): void {
  if (messages.length === 0) {
    throw new Error("A prompt version must contain at least one message.");
  }
  const seen = new Set<string>();
  let userCount = 0;
  for (const m of messages) {
    if (!m.id || typeof m.id !== "string") {
      throw new Error("Every message must have a non-empty id.");
    }
    if (seen.has(m.id)) {
      throw new Error(`Duplicate message id: ${m.id}`);
    }
    seen.add(m.id);
    if (m.role === "user") userCount++;
  }
  if (userCount === 0) {
    throw new Error("A prompt version must contain at least one user message.");
  }
}

/**
 * Derive legacy single-string fields from a messages[] array so pre-M18 readers
 * keep working. First system message → systemMessage; first user message →
 * userMessageTemplate. Multi-turn content beyond the first of each role is lost
 * on the legacy side (the executor uses messages[] directly).
 */
export function deriveLegacyFields(messages: PromptMessage[]): {
  systemMessage?: string;
  userMessageTemplate: string;
  systemMessageFormat?: "plain" | "markdown";
  userMessageTemplateFormat?: "plain" | "markdown";
} {
  const firstSystem = messages.find(
    (m) => m.role === "system" || m.role === "developer",
  );
  const firstUser = messages.find((m) => m.role === "user");

  if (!firstUser || firstUser.role !== "user") {
    // validateMessages should catch this earlier; defensive fallback.
    throw new Error("Cannot derive legacy fields without a user message.");
  }

  const result: {
    systemMessage?: string;
    userMessageTemplate: string;
    systemMessageFormat?: "plain" | "markdown";
    userMessageTemplateFormat?: "plain" | "markdown";
  } = {
    userMessageTemplate: firstUser.content,
  };

  if (firstSystem && (firstSystem.role === "system" || firstSystem.role === "developer")) {
    result.systemMessage = firstSystem.content;
    if (firstSystem.format) result.systemMessageFormat = firstSystem.format;
  }
  if (firstUser.format) result.userMessageTemplateFormat = firstUser.format;

  return result;
}

/**
 * Build a canonical messages[] array from a pre-M18 version that only has
 * legacy fields. Used by the migration and by the executor when operating on
 * versions that haven't been backfilled yet.
 */
export function legacyToMessages(version: {
  systemMessage?: string;
  userMessageTemplate: string;
  systemMessageFormat?: "plain" | "markdown";
  userMessageTemplateFormat?: "plain" | "markdown";
}): PromptMessage[] {
  const messages: PromptMessage[] = [];
  if (version.systemMessage) {
    messages.push({
      id: genMessageId(),
      role: "system",
      content: version.systemMessage,
      format: version.systemMessageFormat,
    });
  }
  messages.push({
    id: genMessageId(),
    role: "user",
    content: version.userMessageTemplate,
    format: version.userMessageTemplateFormat,
  });
  return messages;
}

/**
 * Messages[] that every reader downstream of M18 should consume. If a version
 * has messages[], use it; otherwise synthesize from legacy fields. Does NOT
 * persist — the migration in #111 is responsible for writing the backfill.
 */
export function readMessages(version: {
  messages?: PromptMessage[];
  systemMessage?: string;
  userMessageTemplate: string;
  systemMessageFormat?: "plain" | "markdown";
  userMessageTemplateFormat?: "plain" | "markdown";
}): PromptMessage[] {
  if (version.messages && version.messages.length > 0) {
    return version.messages;
  }
  return legacyToMessages(version);
}

/**
 * Return which legacy targetField a given messageId maps to on a version, or
 * undefined when the message isn't system/user. Used so M18-M22 readers that
 * still key off targetField keep working after a messageId-first write.
 */
export function legacyTargetFieldForMessage(
  messages: PromptMessage[],
  messageId: string,
): "system_message" | "user_message_template" | undefined {
  const msg = messages.find((m) => m.id === messageId);
  if (!msg) return undefined;
  if (msg.role === "system" || msg.role === "developer") {
    // A legacy reader only understands the FIRST system message — anchor
    // annotations on the first one to that slot.
    const firstSystem = messages.find(
      (m) => m.role === "system" || m.role === "developer",
    );
    return firstSystem?.id === messageId ? "system_message" : undefined;
  }
  if (msg.role === "user") {
    const firstUser = messages.find((m) => m.role === "user");
    return firstUser?.id === messageId ? "user_message_template" : undefined;
  }
  return undefined;
}

// Use a dynamic import to keep this module tree-shakeable in any context where
// crypto.randomUUID isn't available (Convex runtime supports it natively).
export function genMessageId(): string {
  return (globalThis.crypto as Crypto).randomUUID();
}
