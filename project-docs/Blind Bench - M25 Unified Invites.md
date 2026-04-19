# Blind Bench — M25: Unified Invites & Guest Identity

## Goal

Collapse the three parallel invitation systems (org members, project collaborators, cycle reviewers) plus the two parallel cycle invite paths (`cycleEvaluators` + `evalInvitations` → `cycleShareableLinks`) into one cohesive invite primitive.

Support **anonymous reviewers** as first-class principals via email verification — they can leave attributed feedback without creating a full account, and their identity can be promoted to a real user later.

**Outcome:** one `InviteDialog`, one invite inbox, one `/invite/<token>` landing route, one mental model for the user. All review flows land in the M24 `reviewSessions` UI.

## Non-goals

- Changing blind-eval security guarantees (Rules 1-13 in UX Spec §10 stay intact)
- SSO / SCIM / enterprise directory sync
- Cross-org invites or marketplace-style discovery
- Changing the M24 session phase model

## Core primitives

### `guestIdentities`

First-class principal for a verified email that hasn't signed up. Created lazily when a guest first clicks an invite link.

```ts
guestIdentities: defineTable({
  email: v.string(),          // normalized lowercase
  verifiedAt: v.number(),     // timestamp of first token click
  displayName: v.optional(v.string()),  // optional, set by guest on first review
  promotedToUserId: v.optional(v.id("users")),  // set when guest signs up later
  promotedAt: v.optional(v.number()),
}).index("by_email", ["email"])
  .index("by_promoted_user", ["promotedToUserId"]),
```

### `invitations`

Unified invite across org/project/cycle scopes.

```ts
invitations: defineTable({
  scope: v.union(v.literal("org"), v.literal("project"), v.literal("cycle")),
  scopeId: v.string(),        // organizationId | projectId | reviewCycleId (as string)
  orgId: v.id("organizations"), // always set, for fast org-wide queries

  role: v.union(
    // org roles
    v.literal("org_owner"), v.literal("org_admin"), v.literal("org_member"),
    // project roles
    v.literal("project_owner"), v.literal("project_editor"), v.literal("project_evaluator"),
    // cycle roles
    v.literal("cycle_reviewer"),
  ),

  email: v.string(),          // normalized lowercase
  token: v.string(),          // opaque, single-use for signup path; multi-use for public shareable variant
  shareable: v.boolean(),     // true = one link, many guests (replaces cycleShareableLinks)

  status: v.union(
    v.literal("pending"),
    v.literal("accepted"),
    v.literal("revoked"),
    v.literal("expired"),
  ),

  invitedById: v.id("users"),
  invitedAt: v.number(),
  expiresAt: v.number(),       // 7d default for scope=org/project; 14d for cycle

  acceptedByUserId: v.optional(v.id("users")),
  acceptedByGuestId: v.optional(v.id("guestIdentities")),
  acceptedAt: v.optional(v.number()),

  // Counters for shareable=true
  acceptCount: v.number(),     // how many distinct principals accepted
  maxAccepts: v.optional(v.number()),
})
  .index("by_token", ["token"])
  .index("by_scope", ["scope", "scopeId"])
  .index("by_email_scope", ["email", "scope", "scopeId"])
  .index("by_org_status", ["orgId", "status"]),
```

### Principal abstraction

```ts
type Principal =
  | { kind: "user"; userId: Id<"users">; email: string }
  | { kind: "guest"; guestId: Id<"guestIdentities">; email: string };

async function requirePrincipal(ctx): Promise<Principal> { ... }
```

Replaces ad-hoc `getAuthUserId(ctx)` at entry points that can serve guests (`reviewSessions`, `cyclePreferences`, `cycleFeedback`, `outputPreferences`, `outputFeedback`). Everything else (prompt edits, key management, etc.) still uses `requireAuth` (user-only).

## Phased migration

### Phase 1 — Schema additions (non-breaking) · **M25.1**

Add the new tables and nullable guest columns; write nothing new yet.

- Add `guestIdentities`, `invitations` tables.
- Add `guestIdentityId: v.optional(v.id("guestIdentities"))` to:
  - `reviewSessions` (today keyed on `userId`; relax to allow guest principal)
  - `outputPreferences`, `cyclePreferences`
  - `outputFeedback`, `cycleFeedback`
- Add `invitedByGuestId` to `evaluatorNotifications` (optional — guests can't send, but the recipient lookup path may need it).
- **Ship.** No behavior change. Verify `npx convex dev` accepts schema, `npm run build` stays clean.

### Phase 2 — Unified invite backend · **M25.2**

New Convex module `convex/invitations.ts`:

- `create({ scope, scopeId, role, email, shareable?, maxAccepts? })` — single mutation, scope-aware auth (org admin for org invites, project owner/editor for project, cycle creator or project owner for cycle).
- `acceptWithAuth({ token })` — authenticated user accepts; materializes the membership row (`organizationMembers` / `projectCollaborators` / `cycleEvaluators`) and sets `status: "accepted"`.
- `acceptAsGuest({ token })` — unauthenticated; creates/fetches `guestIdentities` row keyed on the invite email, records acceptance. Guest principals can only accept `scope: "cycle"` with `role: "cycle_reviewer"` (we do NOT promote guests to org/project members).
- `revoke({ invitationId })` — scope-aware auth.
- `list({ scope, scopeId })` — returns pending + accepted invites for that scope.
- `listMine()` — returns invites pending for the current user's email (replaces `evalInvitations.listForUser`).

Plus `convex/invitationActions.ts`:

- `sendInvitationEmail` (internalAction) — one unified Resend template per scope+role with a single CTA to `/invite/<token>`.

### Phase 3 — New landing route + inbox · **M25.3**

Frontend changes:

- **`src/routes/invite/InviteLanding.tsx`** at `/invite/:token`:
  - Fetch invite meta via `invitations.lookupByToken` (no auth).
  - If authenticated user → show "Accept as {email}" CTA → call `acceptWithAuth` → navigate to scope target (org home / project / review session).
  - If not authenticated:
    - Cycle scope → "Continue as guest" (one-click `acceptAsGuest`) **or** "Sign in to accept" (Google/magic link).
    - Org/project scope → force sign-in (no guest path allowed).
  - On invalid/expired/revoked token: friendly error (routed through `friendlyError`).
- **`src/routes/invite/InvitesInbox.tsx`** at `/eval` (replaces EvalInbox):
  - Lists `invitations.listMine()` grouped by scope.
  - Each item is a one-click "Open review" / "Accept invite" action.
- **`src/components/InviteDialog.tsx`** — scope-aware role picker, email(s) input, optional shareable toggle for cycle scope. Used in three places in Phase 4.

### Phase 4 — Wire UI to new backend · **M25.4**

- **`OrgMembers.tsx`** — replace "Invite member" dialog with `<InviteDialog scope="org" scopeId={orgId} />`. Keep existing member list but read `acceptedByUserId` through a resolver so admins see "Pending" vs "Active".
- **`ProjectCollaborators.tsx`** — replace add-collaborator flow with `<InviteDialog scope="project" scopeId={projectId} />`.
- **`CycleDetail.tsx`** — replace "Send Evaluation" dialog (`SendEvaluationDialog`) with `<InviteDialog scope="cycle" scopeId={cycleId} />`. Support shareable=true for public reviewer links.
- Remove the old `SendEvaluationDialog` once wired.
- Update `OrgHome` resume banner to include pending invites count.

### Phase 5 — Wipe Convex data · **M25.5**

Pre-launch, no real user data to preserve. Instead of a backfill migration:

1. Clear all documents from the dev Convex deployment.
2. Verify new invite flow end-to-end on a clean dev instance (org create → invite member → invite collaborator → invite cycle reviewer → guest accept → review session).
3. Clear prod Convex deployment.

No backfill script, no dual-read soak, no feature flag.

### Phase 6 — Delete legacy surface · **M25.6**

Because data is wiped, deletion is immediate:

- Delete `evalInvitations` table and `convex/evalInvitations.ts` + `convex/evalInvitationActions.ts`.
- Delete `cycleShareableLinks` table + `convex/cycleShareableLinks.ts`.
- Delete `cycleEvalTokens` table (replaced by `invitations.token`).
- Delete route `src/routes/eval/CycleShareableEvalView.tsx` + `/s/cycle/:token` URL.
- Delete `src/routes/eval/EvalInbox.tsx` (replaced by `InvitesInbox`).
- Retire `convex/reviewCycles.ts` functions: `assignEvaluators`, `unassignEvaluator`, `sendCycleAssignmentEmail` (moved into `invitations`).
- Retire unused legacy email templates in `convex/emails/`.

## URL surface after M25

| Path | Purpose |
|---|---|
| `/invite/:token` | Any invite accepts here — org / project / cycle |
| `/eval` | My invites inbox |
| `/review/session/:sessionId` | M24 session UI (unchanged) |
| `/review/cycle/:cycleId` | Author/collaborator entry to cycle review (unchanged) |
| `/review/run/:runId` | Author/collaborator entry to run review (unchanged) |
| ~~`/s/cycle/:token`~~ | **Removed** |
| ~~`/eval/cycle/:cycleEvalToken`~~ | **Removed** |

## Security posture

- **Blind-eval rules preserved:** guest principals accepting `cycle_reviewer` land in the exact same `reviewSessions` flow with the same output filter (`blindLabel`, `outputContent`, `annotations` only).
- **Email-only identity is still attributable:** every rating/comment carries `guestIdentityId`, so cycle authors can see "3 reviewers (2 users + 1 guest: jane@example.com)".
- **No privilege escalation:** `acceptAsGuest` only works for scope=cycle, role=cycle_reviewer. Org/project invites require real auth.
- **Token hygiene:** one-time tokens for targeted email invites; shareable tokens rate-limited via `maxAccepts`.
- **Promotion flow:** if a guest later signs up with the same email, next sign-in triggers `promoteGuestToUser`, which repoints `guestIdentityId` rows and sets `promotedToUserId`.

## Rollback plan

Phases 1-4 ship on a branch and merge together after manual verification on dev. If something breaks in prod we wipe prod again and revert the merge.

## Acceptance criteria

- Single `<InviteDialog>` handles all three scopes.
- Single `/invite/:token` route handles all acceptance paths.
- Anonymous cycle reviewers can leave attributed feedback without signup.
- Guest → user promotion preserves historical attribution.
- All M24 blind-eval guarantees still hold (tested against Rules 1-13).
- No user-visible references to `/s/cycle/…` or `/eval/cycle/…` anywhere.
