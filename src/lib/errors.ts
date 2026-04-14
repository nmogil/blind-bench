/**
 * Known error messages from Convex mutations mapped to user-friendly strings.
 */
const friendlyMessages: Record<string, string> = {
  "User is already a member of this organization":
    "This person is already a member.",
  "User is already a collaborator on this project":
    "This person is already a collaborator.",
  "Cannot remove the sole owner":
    "You can't remove the only owner. Transfer ownership first.",
  "Cannot remove the sole project owner":
    "You can't remove the only prompt owner. Transfer ownership first.",
  "User must be a member of the organization before being added to a project":
    "This person must be an organization member first.",
  "User is not a member of this organization": "Member not found.",
  "User is not a collaborator on this project": "Collaborator not found.",
  "This URL is already taken": "This URL is already taken. Try another slug.",
  "Permission denied": "You don't have permission to do that.",
  "Not authenticated": "You need to sign in first.",
  "A variable named": "A variable with that name already exists.",
  "Only drafts can be edited":
    "This version is locked. Only drafts can be edited.",
  "Only drafts can be deleted":
    "This version is locked. Only drafts can be deleted.",
  "Only drafts can be promoted to active":
    "This version is locked. Only drafts can be promoted.",
  "Unsupported template syntax":
    "Only {{variable}} placeholders are allowed. Conditionals, partials, and helpers are not supported.",
  "No OpenRouter key found":
    "No API key set. Set one in org settings.",
  "OpenRouter rejected your API key":
    "OpenRouter rejected your API key. Check it in org settings.",
  "10 runs in flight":
    "10 runs are in flight. Wait for one to finish.",
  "API key cannot be empty":
    "API key cannot be empty.",
  "Encryption not configured":
    "Encryption is not configured. Contact your administrator.",
  "An optimization is already in progress":
    "An optimization is already running for this prompt. Wait for it to finish.",
  "No feedback to optimize from":
    "No feedback to optimize from. Add feedback first.",
  "Cannot cancel a running optimization":
    "Can't cancel a running optimization.",
  "This optimization is not awaiting review":
    "This optimization is not awaiting review.",
  "No generated content to accept":
    "No generated content to accept.",
  "Slot count must be between 2 and 5":
    "Configure between 2 and 5 output slots.",
  "must have a model selected":
    "Each slot must have a model selected.",
  "A suggestion request is already in progress":
    "A suggestion request is already running.",
  "Select between 2 and 5 versions":
    "Select between 2 and 5 versions to compare.",
  "Test case not found":
    "Test case not found.",
  "Version not found":
    "Version not found.",
  "Run not available":
    "This run is not available yet.",
  "This link is no longer active":
    "This link has expired or been deactivated.",
  "This link has reached its response limit":
    "This link has reached its response limit.",
  "You have already submitted a response":
    "You've already submitted your evaluation for this link.",
  "Can only share completed runs":
    "Only completed runs can be shared.",
  "Link not found":
    "Shareable link not found.",
  "Run not found":
    "Run not found.",
  "Can only add attachments to draft versions":
    "Attachments can only be added to draft versions.",
  "Attachment not found":
    "Attachment not found.",
  "A digest is already being generated":
    "A digest is already being generated. Please wait.",
  "Session not found":
    "Evaluation session not found.",
  "Session is not active":
    "This evaluation session is no longer active.",
  "No more outputs to rate":
    "No more outputs to rate in this session.",
  "Suggestion request not found":
    "Suggestion request not found.",
  "Provide a test case or inline variable values":
    "Provide a test case or inline variable values.",
};

/**
 * Extract a user-friendly error message from a Convex (or generic) error.
 * Convex server errors arrive as strings like:
 *   "[CONVEX M(organizations:inviteMember)] [Request ID: ...] Server Error Uncaught Error: <message>"
 * This function strips the prefix and returns a friendly message.
 */
export function friendlyError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!(err instanceof Error)) return fallback;

  // ConvexError stores the user-facing message in .data
  const raw = "data" in err && typeof err.data === "string" ? err.data : err.message;

  // Pass through user-friendly dynamic messages from the server
  const passThroughPrefixes = [
    "This variable is used in version",
    "Unknown variable",
    "The optimizer referenced unknown variable",
    "The optimizer dropped a required variable",
    "The optimizer returned malformed output",
    "The optimizer returned an incomplete response",
    "The optimizer used unsupported template syntax",
    "The optimizer returned the same prompt",
    "The optimizer's reasoning was not grounded",
    "Slot ",
    "Need at least",
    "You already have an active solo eval session",
  ];
  for (const prefix of passThroughPrefixes) {
    if (raw.includes(prefix)) {
      // Extract the clean message from Convex error wrapping
      const match = raw.match(new RegExp(`(${prefix}[^"]*)`));
      return match?.[1] ?? raw;
    }
  }

  // Check if any known message is contained in the raw error
  for (const [key, friendly] of Object.entries(friendlyMessages)) {
    if (raw.includes(key)) {
      return friendly;
    }
  }

  return fallback;
}

/**
 * Sanitize a persisted errorMessage from an async backend action before
 * displaying it in the UI. These messages come from raw exception catches
 * (OpenRouter API errors, JSON parse failures, etc.) and may contain
 * API keys, request IDs, or overly technical details.
 */
export function sanitizeStoredError(
  message: string | undefined | null,
  fallback = "An unexpected error occurred.",
): string {
  if (!message) return fallback;

  // Strip any leaked API keys (OpenRouter sk-or-..., generic sk-...)
  let cleaned = message.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]");

  // Strip Convex request ID wrappers if they somehow got stored
  cleaned = cleaned.replace(
    /\[CONVEX [A-Z]\([^\)]+\)\]\s*\[Request ID: [^\]]+\]\s*(Server Error\s*)?(Uncaught Error:\s*)?/g,
    "",
  );

  // Map known API error patterns to friendly messages
  const apiPatterns: [RegExp, string][] = [
    [/401\s*(Unauthorized)?/i, "API key was rejected. Check your key in org settings."],
    [/403\s*(Forbidden)?/i, "Access denied by the AI provider. Check your API key permissions."],
    [/429\s*(Too Many Requests|Rate limit)/i, "Rate limit reached. Wait a moment and try again."],
    [/502|503|504/i, "The AI provider is temporarily unavailable. Try again shortly."],
    [/timeout|timed?\s*out|ETIMEDOUT/i, "The request timed out. Try again or use a faster model."],
    [/context.{0,5}length|token.{0,5}limit|too.{0,5}long/i, "The input was too long for the selected model. Try a shorter prompt or a model with a larger context window."],
    [/invalid.*json|JSON\.parse|Unexpected token/i, "The AI returned an invalid response. Try again."],
  ];

  for (const [pattern, friendly] of apiPatterns) {
    if (pattern.test(cleaned)) {
      return friendly;
    }
  }

  // Cap length and return the cleaned message
  if (cleaned.length > 200) {
    cleaned = cleaned.slice(0, 200) + "…";
  }

  return cleaned;
}
