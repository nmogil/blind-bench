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
    "You can't remove the only project owner. Transfer ownership first.",
  "User must be a member of the organization before being added to a project":
    "This person must be an organization member first.",
  "User is not a member of this organization": "Member not found.",
  "User is not a collaborator on this project": "Collaborator not found.",
  "This URL is already taken": "This URL is already taken. Try another slug.",
  "Permission denied": "You don't have permission to do that.",
  "Not authenticated": "You need to sign in first.",
};

/**
 * Extract a user-friendly error message from a Convex (or generic) error.
 * Convex server errors arrive as strings like:
 *   "[CONVEX M(organizations:inviteMember)] [Request ID: ...] Server Error Uncaught Error: <message>"
 * This function strips the prefix and returns a friendly message.
 */
export function friendlyError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!(err instanceof Error)) return fallback;

  const raw = err.message;

  // Check if any known message is contained in the raw error
  for (const [key, friendly] of Object.entries(friendlyMessages)) {
    if (raw.includes(key)) {
      return friendly;
    }
  }

  return fallback;
}
