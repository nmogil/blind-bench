---
title: "Blind Bench - Architecture"
created: 2026-04-11
modified: 2026-04-11
type: architecture
status: planning
tags:
  - blind-bench
  - architecture
  - spec
---

# Blind Bench — Technical Architecture

> Part of [[MOC - Blind Bench]]

> Ingestion-neutral blind human review for completed AI runs

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Flow: Prompt Optimization Cycle](#data-flow-prompt-optimization-cycle)
4. [Data Model (Convex Schema)](#data-model-convex-schema)
5. [Template Syntax](#template-syntax)
6. [Authorization Model](#authorization-model)
7. [BYOK Key Handling](#byok-key-handling)
8. [Cost Controls](#cost-controls)
9. [File Storage & DB Size](#file-storage--db-size)
10. [Convex Function Index](#convex-function-index)
11. [Frontend UI Layers (M27)](#frontend-ui-layers-m27)
12. [Optimizer Meta-Prompt](#optimizer-meta-prompt)
13. [Key Design Decisions](#key-design-decisions)
14. [v1 Scope & Deferred](#v1-scope--deferred)
15. [Next Steps](#next-steps)

---

## Overview

**Blind Bench** is the execution-neutral blind human-review layer for completed AI runs. Customers execute prompts and agents in their existing harnesses, gateways, CI, or observability stack; Blind Bench imports the resulting evidence, removes provenance from reviewer-facing projections, captures independent judgment, and exports reusable evaluation artifacts.

### Core Workflow (M33 direction of record)

```
1. EXECUTE ELSEWHERE   2. IMPORT          3. REVIEW BLIND     4. REUSE
───────────────────    ─────────          ───────────────     ────────
Pi, Claude Code,       CSV, OTLP, native  Experts inspect     Verdicts become
CI, gateways, and      JSON, or harness   opaque trajectory   regression cases,
customer runtimes      session JSONL      review sessions     evidence, or exports
```

The original prompt playground remains supported as a secondary authoring and experimentation tool. It is not the first-run path or the architectural center. Blind Bench does **not** provision sandboxes, execute arbitrary harness code, store runtime credentials, or own runtime cleanup and compute billing.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + Vite + Tiptap (Vercel) |
| Backend | Convex (queries / mutations / actions) |
| Database | Convex DB |
| Auth | Convex Auth |
| File Storage | Convex file storage |
| Optional playground LLM provider | OpenRouter (BYOK per org; secondary flow) |
| Primary ingest boundary | Native `eval-record` v1 plus CSV, OTLP, Pi, and Claude Code adapters |
| Observability | TODO — action-layer seam preserved |

---

## Architecture

### High-Level

```
┌───────────────────────────────────────────────────────────────┐
│                           CLIENTS                              │
│                                                                │
│     Landing Page (Vercel)            Web App (Vercel)          │
│                                      React + Vite + Tiptap     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ Convex client (reactive queries,
                           │  mutations, action calls)
                           ▼
┌───────────────────────────────────────────────────────────────┐
│                            CONVEX                              │
│                                                                │
│   queries             reads, reactive subscriptions            │
│   mutations           transactional writes, can schedule       │
│                       actions                                  │
│   actions             Node.js runtime, OpenRouter HTTP calls,  │
│                       streaming, can call internal mutations   │
│   scheduled           retries, cleanup, cron                   │
│   file storage        attachments, raw LLM responses           │
│   Convex Auth         sessions, OAuth, magic links             │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTPS
                           ▼
┌───────────────────────────────────────────────────────────────┐
│                         OpenRouter                             │
│       Claude  │  GPT-4  │  Gemini  │  Llama  │  etc.           │
└───────────────────────────────────────────────────────────────┘
```

### Authentication

Convex Auth owns the session end-to-end: OAuth providers, magic links, session tokens in cookies. On every query, mutation, and action, the first lines of code are:

```ts
const identity = await ctx.auth.getUserIdentity();
if (!identity) throw new Error('Not authenticated');
await requireRole(ctx, projectId, ['owner', 'editor']); // or similar
```

`requireRole` is a shared helper that looks up the caller in `projectCollaborators` and throws if they're not in the allowed role set. See the Authorization Model section below.

---

## Data Flow: Prompt Optimization Cycle

```
  Owner creates prompt
           │
           ▼
  PROMPT VERSION 1 ◄───────────────────────────┐
           │                                    │
           │ Owner picks a test case, clicks Run│
           ▼                                    │
  EXECUTE 3 RUNS                                │
  Run 1 → Output A                              │
  Run 2 → Output B                              │
  Run 3 → Output C                              │
           │                                    │
           │ Collaborators invited               │
           ▼                                    │
  BLIND EVALUATION                              │
  Evaluators see outputs labeled A/B/C,         │
  not which version produced them.              │
  Highlight + comment via Tiptap.               │
           │                                    │
           ▼                                    │
  FEEDBACK COLLECTED                            │
  Output feedback + prompt feedback +           │
  project meta context                          │
           │                                    │
           │ Owner clicks Optimize              │
           ▼                                    │
  OPTIMIZER ACTION                              │
  Meta-prompt takes all feedback →              │
  new prompt + changes summary                  │
           │                                    │
           │ Owner reviews                      │
           ▼                                    │
  HUMAN REVIEW (accept / edit / reject)         │
           │                                    │
           │ Accept                             │
           ▼                                    │
  PROMPT VERSION 2 ──────────────────────────────┘
  (parent: v1)

  Rollback: v4 = copy of v2 with parent=v3, sourceVersion=v2
```

### How a run actually executes in Convex

1. Client calls `runs.execute` mutation with `{ versionId, testCaseId, model, temperature, maxTokens, runCount: 3 }`.
2. The mutation writes one `promptRuns` row with `status: 'pending'`, writes three `runOutputs` rows with empty `outputContent` and blind labels A/B/C, then schedules `runsActions.executeRunAction`.
3. The action loads the test case, substitutes variables into the user message template, decrypts the org's OpenRouter key, and fires three parallel streaming calls to OpenRouter.
4. On each streamed chunk, the action calls the internal mutation `runs.appendOutputChunk`, which appends text to the corresponding `runOutputs.outputContent`.
5. The client is already subscribed to a `runs.get(runId)` reactive query and sees the outputs fill in live.
6. On completion the action writes final token counts, latency, and sets `status: 'completed'`. On failure it sets `status: 'failed'` with an error message.

### How optimization executes

1. Client calls `optimize.requestOptimization` mutation with `{ versionId }`.
2. Mutation writes an `optimizationRequests` row with `status: 'pending'` and schedules `optimizeActions.runOptimizerAction`.
3. Action reads the current prompt version, all output feedback for runs of that version, all prompt feedback, and the project's meta context.
4. Action runs the fixed optimizer meta-prompt against OpenRouter.
5. Action writes `generatedSystemMessage`, `generatedUserTemplate`, `changesSummary`, `changesReasoning`, sets `status: 'completed'` and `reviewStatus: 'pending'`.
6. Client is subscribed to `optimize.getOptimization(id)` and sees the result appear.
7. Owner reviews and calls `accept` / `reject` / `editAndAccept`. Accept creates a new `promptVersions` row linked back via `optimizationRequests.resultingVersionId`.

---

## Data Model (Convex Schema)

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // ============================================================
  // ORGS & MEMBERSHIP
  // (users / sessions / accounts are handled by Convex Auth)
  // ============================================================

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    logoStorageId: v.optional(v.id('_storage')),
  }).index('by_slug', ['slug']),

  organizationMembers: defineTable({
    organizationId: v.id('organizations'),
    userId: v.id('users'),
    role: v.union(
      v.literal('owner'),
      v.literal('admin'),
      v.literal('member'),
    ),
  })
    .index('by_org', ['organizationId'])
    .index('by_user', ['userId'])
    .index('by_org_user', ['organizationId', 'userId']),

  // ============================================================
  // BYOK: OpenRouter keys per org
  // ============================================================

  openRouterKeys: defineTable({
    organizationId: v.id('organizations'),
    // AES-GCM encrypted with a key derived from the Convex env var
    // OPENROUTER_KEY_ENCRYPTION_SECRET. Nonce stored with ciphertext.
    encryptedKey: v.string(),
    lastRotatedAt: v.number(),
    createdById: v.id('users'),
  }).index('by_org', ['organizationId']),

  // ============================================================
  // PROJECTS
  // ============================================================

  projects: defineTable({
    organizationId: v.id('organizations'),
    name: v.string(),
    description: v.optional(v.string()),
    createdById: v.id('users'),
    // Meta-prompting context questions the owner fills in once per
    // project. Feeds the optimizer. Typical questions: "What domain?",
    // "What tone?", "Who's the end user?"
    metaContext: v.optional(
      v.array(
        v.object({
          id: v.string(),
          question: v.string(),
          answer: v.string(),
        }),
      ),
    ),
  }).index('by_org', ['organizationId']),

  projectCollaborators: defineTable({
    projectId: v.id('projects'),
    userId: v.id('users'),
    role: v.union(
      v.literal('owner'),
      v.literal('editor'),
      v.literal('evaluator'),
    ),
    // M26: present when role === "evaluator". `false` = open reviewer (sees
    // the prompt and outputs in full), `true` or absent = blind reviewer
    // (today's evaluator semantics). Ignored for owner/editor.
    blindMode: v.optional(v.boolean()),
    invitedById: v.id('users'),
    invitedAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index('by_project', ['projectId'])
    .index('by_user', ['userId'])
    .index('by_project_user', ['projectId', 'userId']),

  // M26: same flag on the unified invitations table — propagates to
  // projectCollaborators on accept for project_evaluator + cycle_reviewer
  // roles. Set at invite time only; the schema doesn't support flipping
  // a live row (see UX Spec Rule 7 — re-blinding is not supported).

  // ============================================================
  // PROJECT-LEVEL VARIABLES
  // Shared across all versions of a project. Referenced by name
  // in prompt templates.
  // ============================================================

  projectVariables: defineTable({
    projectId: v.id('projects'),
    name: v.string(), // e.g., "customer_name"
    description: v.optional(v.string()),
    // M21: variable type. Defaults to "text" for back-compat.
    // Image variables (type === "image") store no defaultValue and may
    // only appear in messages with role === "user". Type is set at
    // creation and cannot change.
    type: v.optional(v.union(v.literal('text'), v.literal('image'))),
    // Only meaningful for text variables. Image variables reject defaultValue.
    defaultValue: v.optional(v.string()),
    required: v.boolean(),
    order: v.number(),
  }).index('by_project', ['projectId']),

  // ============================================================
  // TEST CASES (first-class, reusable across versions)
  // Running the same test case against v1, v2, v3 is the primitive
  // for cross-version comparison.
  // ============================================================

  testCases: defineTable({
    projectId: v.id('projects'),
    name: v.string(),
    // Values for the project's text variables for this test case.
    variableValues: v.record(v.string(), v.string()),
    // Legacy in-prompt attachments — always appended to the last user
    // message at dispatch. Distinct from image variables below.
    attachmentIds: v.array(v.id('_storage')),
    // M21: per-image-variable storage IDs. Key is the variable name
    // (must match a projectVariables row with type === "image"). At
    // dispatch, the blob is base64-inlined as an image_url content
    // block at the position of the {{name}} token in the user message.
    variableAttachments: v.optional(v.record(v.string(), v.id('_storage'))),
    order: v.number(),
    createdById: v.id('users'),
  }).index('by_project', ['projectId']),

  // ============================================================
  // PROMPT VERSIONS
  // ============================================================

  promptVersions: defineTable({
    projectId: v.id('projects'),
    versionNumber: v.number(),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.string(),
    // Parent is always the previous version in the sequence.
    parentVersionId: v.optional(v.id('promptVersions')),
    // For rollbacks: if v4 was rolled back from v2, sourceVersionId = v2.
    sourceVersionId: v.optional(v.id('promptVersions')),
    status: v.union(
      v.literal('draft'),
      v.literal('active'),
      v.literal('archived'),
    ),
    createdById: v.id('users'),
  }).index('by_project', ['projectId']),

  // ============================================================
  // PROMPT-LEVEL ATTACHMENTS
  // Images attached to the prompt itself (not a specific test case).
  // Included in every run regardless of which test case is used.
  // ============================================================

  promptAttachments: defineTable({
    promptVersionId: v.id('promptVersions'),
    storageId: v.id('_storage'),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    order: v.number(),
  }).index('by_version', ['promptVersionId']),

  // ============================================================
  // RUNS & OUTPUTS
  // ============================================================

  promptRuns: defineTable({
    promptVersionId: v.id('promptVersions'),
    testCaseId: v.id('testCases'),
    model: v.string(), // OpenRouter model id
    temperature: v.number(),
    maxTokens: v.optional(v.number()),
    status: v.union(
      v.literal('pending'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    triggeredById: v.id('users'),
  })
    .index('by_version', ['promptVersionId'])
    .index('by_version_testcase', ['promptVersionId', 'testCaseId']),

  runOutputs: defineTable({
    runId: v.id('promptRuns'),
    // Blind label shown to evaluators instead of version info.
    blindLabel: v.string(), // "A", "B", "C"
    // Accumulated via chunk-append during streaming.
    outputContent: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    // Raw response is only kept in file storage if needed for
    // debugging. Never a JSON blob in the DB row.
    rawResponseStorageId: v.optional(v.id('_storage')),
  }).index('by_run', ['runId']),

  // ============================================================
  // FEEDBACK (Tiptap annotations)
  // ============================================================

  outputFeedback: defineTable({
    outputId: v.id('runOutputs'),
    userId: v.id('users'),
    // Tiptap / ProseMirror position data.
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
  })
    .index('by_output', ['outputId'])
    .index('by_user', ['userId']),

  promptFeedback: defineTable({
    promptVersionId: v.id('promptVersions'),
    userId: v.id('users'),
    targetField: v.union(
      v.literal('system_message'),
      v.literal('user_message_template'),
    ),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
  })
    .index('by_version', ['promptVersionId'])
    .index('by_user', ['userId']),

  // ============================================================
  // OPTIMIZATION REQUESTS
  // ============================================================

  optimizationRequests: defineTable({
    promptVersionId: v.id('promptVersions'),
    status: v.union(
      v.literal('pending'),
      v.literal('processing'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    // The generated new prompt (before human review).
    generatedSystemMessage: v.optional(v.string()),
    generatedUserTemplate: v.optional(v.string()),
    // Optimizer's explanation.
    changesSummary: v.optional(v.string()),
    changesReasoning: v.optional(v.string()),
    optimizerModel: v.string(),
    // Human review.
    reviewStatus: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('accepted'),
        v.literal('rejected'),
        v.literal('edited'),
      ),
    ),
    reviewedById: v.optional(v.id('users')),
    reviewedAt: v.optional(v.number()),
    reviewNotes: v.optional(v.string()),
    // If accepted, the new version created from this optimization.
    resultingVersionId: v.optional(v.id('promptVersions')),
    requestedById: v.id('users'),
    errorMessage: v.optional(v.string()),
  }).index('by_version', ['promptVersionId']),
});
```

---

## Template Syntax

> Terms referenced below are defined in [[Blind Bench - Glossary]].

Templates use a minimal subset of Mustache. Keep it boring on purpose.

- `{{variable}}` is replaced with the test case's value for `variable`. Must reference a variable defined on the project.
- Escape with `\{{literal}}` if you need a literal `{{` in the output.
- **No logic, no conditionals, no partials, no helpers.** If we add any of those later, it's a deliberate upgrade.
- Missing variables throw at execute time. Test cases may include values for variables that don't exist in the current template — that's fine (ignored).
- **Validation on version save.** Every `{{name}}` appearing in `systemMessage` or `userMessageTemplate` must correspond to an existing `projectVariables.name` row. Unreferenced project variables are allowed.

### Image variables (M21)

Variables with `type === "image"` follow the same `{{name}}` syntax but resolve to multimodal content blocks rather than inline text:

- **Role restriction.** Image variable tokens may appear **only in messages with role `user`**. Putting `{{imageVar}}` in a system, developer, or assistant message is rejected at version save with a named error. OpenRouter's docs technically allow images in system messages, but Anthropic's native API forbids it and other providers' normalization is inconsistent — user-only is the lowest common denominator. Enforced in `convex/lib/templateValidation.ts`.
- **Dispatch shape.** A user message containing `{{imageVar}}` is emitted as an OpenAI-compatible content array — text segments around the token become `{type: "text", text}` blocks; the token itself becomes `{type: "image_url", image_url: {url: "data:<mime>;base64,..."}}`. Messages with no image tokens continue to emit `content: string` (no behavioral change for non-vision runs). The base64 conversion happens in `buildDispatchMessages()` (`convex/runsActions.ts`); the storage blob is fetched fresh on every run rather than cached.
- **Capability gate.** If a test case has any image variable values, the chosen model must include `"image"` in `architecture.input_modalities` from OpenRouter's `/api/v1/models`. Pre-dispatch check in `runs.execute` fails the run early with `"Model {modelId} doesn't support image inputs."`.
- **Missing values.** A required image variable with no value on the chosen test case fails the run before dispatch. An optional image variable with no value substitutes empty string for the token (the user message renders without the image).
- **Optimizer-immutable.** The optimizer (M5) receives the list of image variable names and is instructed not to modify their tokens. Post-processed in `convex/optimize.ts` — any rewrite that drops, renames, or relocates an image variable token is rejected and retried once.

---

## Authorization Model

All authorization is enforced inside Convex functions, not in the UI. Every query, mutation, and action starts with `ctx.auth.getUserIdentity()` and `requireRole(ctx, projectId, allowedRoles)`.

### Membership model — three rings (M29.2)

Access is structured as three non-overlapping rings. Each invite scope writes exactly one row into exactly one membership table on accept; cross-scope writes are forbidden.

| Ring | Table | Granted by | Surfaces unlocked |
|---|---|---|---|
| **Org member** | `organizationMembers` | Org invite (`scope=org`) or org creation | Org sidebar, project list (`projects.list`), org settings, BYOK key management, ability to create new projects in the org |
| **Project collaborator** | `projectCollaborators` | Project invite (`scope=project`) or cycle invite (`scope=cycle`, role=`evaluator`); also written for the project creator | Single-project access at the granted role (`owner` / `editor` / `evaluator`). Independent of org membership. |
| **Guest** | `guestIdentities` | Guest acceptance of a cycle invite | Unauthenticated review-session surface only. Tracked as a separate principal type (see `Principal` in `convex/lib/auth.ts`). |

**Why the rings are non-overlapping.** Org membership and project collaboration are separate access surfaces by design: a project invitee should not implicitly gain access to the rest of the inviter's workspace, and a cycle reviewer should not be marked as a permanent member of someone else's org. `requireProjectRole` reads `projectCollaborators` only — it does not require org membership — so a project-only collaborator can use the project they were invited to via a direct URL while remaining outside the org.

**`cycleEvaluators` is a status table, not a ring.** Cycle invite acceptance writes both a `projectCollaborators` row (the access ring) and a `cycleEvaluators` row (per-cycle pending / in_progress / completed state). The status row is workflow tracking — it does not grant or revoke access — and so does not violate the one-row-per-scope rule.

**Onboarding signal is decoupled from membership (M29.1).** Workspace ownership (`organizations.createdById === userId`) — not "any membership row" — is the canonical first-run-completion signal. A brand-new user invited only to a project or cycle still gets a personal workspace created lazily by the welcome screen the first time they actually need one (paste a prompt or load the example), instead of being stranded on a low-privilege view of someone else's org.

See `convex/invitations.ts` for the per-scope acceptors (`acceptOrgInvite`, `acceptProjectInvite`, `acceptCycleInvite`) and `convex/sampleSeed.ts` for the personal-org helpers.

### First-run flow (M29)

Post-auth, zero-project users land on `/welcome` (`src/routes/welcome/WelcomeFirstRun.tsx`) with one question and two paths:

- **"I have a prompt I'm working on"** — `projects.createFromPaste(content, role)` creates a personal workspace if needed, an "Untitled prompt" project, and a v1 promptVersion seeded with the pasted content as a single message at the requested role (system or user). `{{variables}}` are auto-detected and persisted.
- **"Show me an example"** — `projects.cloneStarter()` materializes the canonical starter fixtures (`convex/fixtures/sampleProject.ts`) into a fully-mutable project. The fixture seeds a variable, a test case, a v1 promptVersion, a sample completed run with 3 outputs, blind annotations, and a pending optimizer suggestion — so the user can experience every loop surface without spending tokens, but everything is editable from minute zero.

Both paths drop the user directly into the version editor. There is no "this is a sample" gate — the M28-era `isSample` flag and `assertProjectMutable` were removed (M29.3 / M29.8).

**Inline BYOK at the run button (M29.5).** OpenRouter key entry is no longer a setup-step gate; the Run button stays alive for keyless users and `<InlineBYOKModal>` intercepts the click, saves the key, and immediately re-fires the run with the same args (`src/components/InlineBYOKModal.tsx`, used from `RunConfigurator.tsx`). Non-owners get an ask-your-admin variant.

**Post-first-run collaboration nudge (M29.6).** After a user's first successful run on their first owned project, the co-pilot panel raises a high-priority "Get feedback — copy invite link" card (`onboarding.collabNudge`). One click mints (or reuses) a shareable `project_evaluator` invite via `invitations.mintShareableProjectInvite` and writes the URL to the clipboard. The card hides once any other reviewer collaborator joins, or on explicit dismiss.

**Co-pilot ambient steps (M29.7).** Post-welcome, the co-pilot panel cycles through four ambient steps tuned to real project state: write_prompt → run_eval → compare_model → promote_test_case (`onboarding.copilotProgress`, `src/components/CopilotPanel.tsx`). The collab card sits above this list as a higher-priority surface.

### Role + Blind Mode (M26)

A collaborator carries two pieces of state: a **role** (`owner` / `editor` / `evaluator`) that controls what they can mutate, and a **blindMode** flag (only meaningful for `evaluator`) that controls what they can read. The split exists so a single role literal can serve two distinct personas:

- **Blind reviewer** — `role === "evaluator"`, `blindMode === true` (or absent). Today's evaluator. Sees A/B/C-labeled outputs in a session; never sees the prompt, model, or which version produced which output.
- **Open reviewer** — `role === "evaluator"`, `blindMode === false`. PM / legal / domain expert. Reads the prompt and outputs in full; leaves prompt + output feedback; cannot edit, run, or trigger optimization.

`blindMode` is set at invite time on `invitations.blindMode` and propagates to `projectCollaborators.blindMode` on accept. It is ignored for `owner` / `editor` (and structurally inert — every `blindMode` check is gated on `role === "evaluator"` first). The schema does not support flipping a live row to `true` after the reviewer has already seen prompt content; see UX Spec Rule 7.

Helper: `isBlindReviewer(ctx, projectId)` in `convex/lib/auth.ts`. Every blind-eval security filter rides on it instead of `role === "evaluator"`. Treat that helper as the canonical gate.

| Action | Owner | Editor | Reviewer (open) | Reviewer (blind) |
|---|:-:|:-:|:-:|:-:|
| View project, versions, variables, test cases | ✓ | ✓ | ✓ (read-only) | — |
| Create / edit versions | ✓ | ✓ | — | — |
| Create / edit test cases | ✓ | ✓ | — | — |
| Upload attachments | ✓ | ✓ | — | — |
| Execute runs | ✓ | ✓ | — | — |
| View outputs (blinded, A/B/C, no version info) | ✓ | ✓ | ✓ | ✓ |
| View which version produced an output | ✓ | ✓ | ✓ | — |
| Leave output feedback | ✓ | ✓ | ✓ | ✓ |
| Leave prompt feedback | ✓ | ✓ | ✓ | — |
| Request optimization | ✓ | ✓ | — | — |
| Accept / reject / edit optimization | ✓ | ✓ | — | — |
| Invite collaborators, change roles | ✓ | — | — | — |
| Delete project | ✓ | — | — | — |
| Set OpenRouter key (org-level) | ✓ | — | — | — |

**Blind-eval enforcement.** A blind reviewer's only runs-related path is the session-scoped surface (`reviewSessions.*`) which exposes `{ blindLabel, outputContent }` and nothing else — no `versionId`, no `runId` metadata, no model, no temperature, no latency. Their calls to `runs.get`, `runs.list`, `versions.get`, etc. throw "Permission denied" inline (the role list admits `evaluator` but the helper rejects when `blindMode !== false`). A blind reviewer holding a raw `outputId` cannot traverse `outputs → runs → versions` because every function in that chain calls `isBlindReviewer` first.

Open reviewers (blindMode=false) are explicitly admitted to those read paths, so the dashboard at `/review/:projectId` and the read-only `VersionEditor` mode work. Editor-only mutations (`versions.update`, `runs.execute`, `optimize.requestOptimization`, etc.) reject `role === "evaluator"` regardless of blindMode — the open reviewer never escalates.

The function-level rules above close the data layer. The browser-side surfaces (URL, page title, breadcrumb, tooltip, tab, favicon, network response, clipboard, view-source, EXIF) are closed separately by the 13 rules in [[Blind Bench - UX Spec#10 Blind eval security rules]]. Those rules now apply when `blindMode === true`, not when `role === "evaluator"`. Both layers are load-bearing.

### Invite flow with blindMode

```
Owner sets blindMode in InviteDialog
        │
        ▼
invitations.create({ role, blindMode })
        │  (rate-limited / token generated)
        ▼
invitations.acceptWithAuth(token)
        │  materializeMembership copies invite.blindMode →
        │  projectCollaborators.blindMode for evaluator rows.
        │  Owner/editor inserts ignore the flag.
        ▼
projectCollaborators row (role + blindMode)
        │
        ▼
isBlindReviewer(ctx, projectId) reads the flag at every call site.
```

---

## BYOK Key Handling

Each organization stores its own OpenRouter key. No platform key in v1.

- **Storage.** `openRouterKeys.encryptedKey` is AES-GCM ciphertext. The encryption key is derived (HKDF) from the Convex env var `OPENROUTER_KEY_ENCRYPTION_SECRET`. The nonce is stored with the ciphertext.
- **Write path.** `openRouterKeys.setKey` mutation (owner only) takes plaintext, encrypts, writes the row. Overwrites any existing row and bumps `lastRotatedAt`.
- **Read path.** Never exposed to the client. `openRouterKeys.hasKey` query returns `boolean` so the UI can prompt for a key when one isn't set. Decryption happens only inside actions that call OpenRouter, via an internal helper `getDecryptedKey(ctx, orgId)`.
- **Risk.** A compromised `OPENROUTER_KEY_ENCRYPTION_SECRET` compromises every stored key. Treat it accordingly — Convex env var, never committed, rotated on compromise.

---

## Cost Controls

Because each org uses its own OpenRouter key (BYOK), users eat their own costs and v1 does not need a billing or budget system. One safeguard ships anyway:

- **Concurrent run cap per project.** A soft cap (default: 10 in-flight runs per project) enforced in the `runs.execute` mutation. Implementation: count `promptRuns` where `status in ('pending','running')` and `projectId = X` before scheduling; throw if over cap. This exists to prevent a runaway loop (bad optimizer, accidental infinite automation) from firing thousands of streaming calls against the org's key in a single minute.

No dollar budgets, no per-user rate limits, no usage dashboards in v1.

---

## File Storage & DB Size

- **Uploads.** Client calls `attachments.generateUploadUrl` (or `imageVariableAttachments.generateUploadUrl` for M21 image variable values) → PUTs the file directly to Convex storage → calls `attachments.registerUploaded` with the returned `storageId`. Image variable uploads are committed by writing the storage ID into `testCases.variableAttachments[varName]` on the next test case save.
- **Reads.** Always via `ctx.storage.getUrl(storageId)` on every read. No cached URLs stored in the DB.
- **Vision payloads.** When an action executes a run, it loads attachment files via `ctx.storage.get(storageId)` and emits OpenRouter `image_url` content blocks. Image bytes are base64-inlined as `data:<mime>;base64,...` URLs in the dispatched payload — portable across every provider OpenRouter routes to (OpenAI, Anthropic, Google, xAI, Mistral, Llama vision) without per-provider branching. We pay request-size for portability; that trade is fine for an eval tool with infrequent runs.
- **Mime + size constraints (M21).** Image variable uploads accept only `image/jpeg`, `image/png`, `image/webp`, `image/gif` and a 5MB cap per file. Mirrors OpenRouter's documented mime allowlist and the Anthropic provider floor. Validated server-side in `convex/imageVariableAttachments.ts`.
- **Capability detection.** `convex/modelCatalog.ts` caches `architecture.input_modalities` from OpenRouter's `/api/v1/models` so `runs.execute` can gate image-bearing test cases on vision-capable models without a synchronous round trip per run.
- **Cascade delete (M21).** Deleting a test case, an image-typed project variable, or a project must delete the referenced storage blobs (`ctx.storage.delete`). Replace and remove flows in the test case editor delete the prior blob atomically with the storage ID swap. No orphans.
- **Raw LLM responses.** Not stored as JSON in DB rows. If a future debugging need arises, dump to file storage and keep only a `rawResponseStorageId` on `runOutputs`. Prevents row bloat.
- **DB size.** Convex has no practical row-count limit for this workload.

---

## Convex Function Index

Every function starts with auth + `requireRole`. The index below groups functions by file.

### `convex/auth.ts`
Handled by Convex Auth. No custom code beyond provider config (Google, GitHub, magic link).

### `convex/organizations.ts`
- `createOrg` mutation — creates org + owner membership in one transaction.
- `listMyOrgs` query — orgs the caller is a member of.
- `getOrg` query — org details.
- `updateOrg` mutation — name, slug, logo.
- `inviteMember` mutation — add org member.
- `updateMemberRole` mutation.
- `removeMember` mutation.

### `convex/openRouterKeys.ts`
- `setKey` mutation (owner only) — encrypt + store.
- `hasKey` query — returns `boolean`, never the key itself.

### `convex/projects.ts`
- `create`, `list`, `get`, `update`, `delete` — standard CRUD.
- `setMetaContext`, `getMetaContext` — owner only.
- `inviteCollaborator`, `updateCollaboratorRole`, `removeCollaborator`, `acceptInvitation`.

### `convex/variables.ts` (project-scoped)
- `list`, `add`, `update`, `delete`, `reorder`.

### `convex/testCases.ts`
- `list`, `create`, `update`, `delete`, `reorder`.

### `convex/versions.ts`
- `list`, `get`, `getCurrent` — read.
- `create` — first version, or a new draft branching from the current head.
- `update`, `delete` — draft only.
- `rollback(versionId)` — copies the target version into a new version at the head. The new version has `parentVersionId = previous head` and `sourceVersionId = target`, preserving both the sequence and the rollback provenance.

### `convex/attachments.ts`
- `generateUploadUrl` mutation — returns a signed upload URL.
- `registerUploaded` mutation — writes the `promptAttachments` row after successful upload.
- `list`, `delete`, `reorder`.

### `convex/imageVariableAttachments.ts` (M21)
Storage layer for [[Blind Bench - Glossary#Image variable]] values on test cases. Mirrors the `attachments.ts` pattern but scoped to per-variable test case uploads, and enforces the multimodal mime allowlist + 5MB cap.
- `generateUploadUrl` mutation — owner / editor only. Returns a signed upload URL.
- `getUrl` query — admits any project role (image variable values are test input, not prompt content; visible to reviewers including blind).
- `delete` action — owner / editor only. Used by the test case editor's replace/remove flows and the cascade-delete paths.
- Server-side validation: mime ∈ {jpeg, png, webp, gif}, size ≤ 5MB, non-zero bytes.

### `convex/runs.ts`
- `execute` mutation — `{ versionId, testCaseId, model, temperature, maxTokens, runCount }`. Enforces the concurrent-run cap, writes the `promptRuns` + three empty `runOutputs`, and schedules `runsActions.executeRunAction`.
- `list` — list runs for a version.
- `get` — full run detail with outputs and version metadata. Editor/owner only.
- `getOutputsForEvaluator(runId)` — returns `{ blindLabel, outputContent }[]` only. The only runs-related function an evaluator can call.
- `compareAcrossVersions({ testCaseId, versionIds })` — for the cross-version comparison UI. Returns `{ versionId → outputs[] }`. Editor/owner only.
- `appendOutputChunk` internal mutation — called by the action on every streamed chunk.

### `convex/runsActions.ts`
- `executeRunAction` internal action — loads the test case, decrypts the org's OpenRouter key, fires three parallel streaming calls, appends chunks via `runs.appendOutputChunk`, finalizes status and token counts.
- `buildDispatchMessages` helper — substitutes text variables, then walks each user message for `{{imageVar}}` tokens (M21). For messages with image tokens, emits a content array of `text` + `image_url` blocks where image blocks carry base64 data URLs fetched from Convex storage. Messages without image tokens still emit `content: string`. Per-test-case attachment IDs (legacy path) continue to be appended as image blocks to the last user message.

### `convex/feedback.ts`
- `addOutputFeedback`, `listOutputFeedback`, `updateOutputFeedback`, `deleteOutputFeedback`.
- `addPromptFeedback`, `listPromptFeedback`, `updatePromptFeedback`, `deletePromptFeedback`.

### `convex/optimize.ts`
- `requestOptimization` mutation — writes the `optimizationRequests` row, schedules the action.
- `getOptimization` query — reactive subscription target.
- `acceptOptimization` — creates a new `promptVersions` row and links it back via `resultingVersionId`.
- `rejectOptimization`.
- `editAndAcceptOptimization` — accept with user-supplied edits.

### `convex/optimizeActions.ts`
- `runOptimizerAction` internal action — reads the current prompt + all feedback + meta context, runs the meta-prompt through OpenRouter, writes `generatedSystemMessage`, `generatedUserTemplate`, `changesSummary`, `changesReasoning`. As of M27.5, also emits a `changes: [{ range: { from, to }, rationale }]` array used by the inline optimizer markers in the UI.

---

## Frontend UI Layers (M27)

The frontend is organized into three layers. M27 codifies this split so primitives stay reusable and feature surfaces stay scannable.

### Primitives (`src/components/ui/`)

The shadcn-derived primitive layer. New M27 additions:

| Primitive | Purpose | Notes |
|---|---|---|
| `CountBadge` | Compact count display on tabs / column headers / inbox items | Variants: `default`, `subtle`, `accent`. Uses tabular monospace numerics. |
| `CopyButton` | One-click copy with a "Copied" flash | Variants: `overlay` (absolutely positioned over a code block) and `inline`. Falls back to a textarea-selection method when `navigator.clipboard` is unavailable. |
| `ScrollFade` | Gradient masks at top/bottom of overflowing scroll containers | `ResizeObserver` + scroll listener; respects `prefers-reduced-motion`. |
| `LiveLogViewer` | Streaming log viewer with smart auto-scroll | Sticks to bottom unless the user scrolls up (then exposes a "Jump to bottom" pill). Truncates oversized logs with a leading `[earlier output truncated]` marker. |

These all live alongside existing primitives (`button`, `dialog`, `dropdown-menu`, etc.) and use the OKLch token set in `src/index.css`.

### Feature components (`src/components/`)

Domain components composed from primitives. New M27 additions:

| Component | Path | Composes |
|---|---|---|
| `<AnnotationToolbar>` | `src/components/annotations/` | floating drag layer + `<LabelPicker>` + textarea + submit |
| `<LabelPicker>` | `src/components/annotations/` | tonal pills using OKLch tint tokens |
| `<OptimizerMarker>` | `src/components/optimizer/` | Tiptap gutter decoration + popover |
| `<OptimizerHistory>` | `src/components/optimizer/` | scroll-faded list of optimizer runs |
| `<WelcomeFirstRun>` | `src/routes/welcome/` | M29.4 first-run paste-or-clone screen |
| `<CopilotPanel>` | `src/components/CopilotPanel.tsx` | persistent ambient-step rail + M29.6 collab nudge card |

### Dock layout (`src/components/dock/`)

`dockview-react` (~50KB gzipped) is added as a dependency to host the multi-panel workspace. The integration is intentionally thin:

- `panelRegistry.ts` — typed `PANEL_TYPES` map → React component for each panel kind (`EDITOR`, `EVAL_GRID`, `ANNOTATIONS`, `OPTIMIZER_HISTORY`, `RUN_LOGS`).
- `Dock.tsx` — wraps `DockviewReact` with theme bridging from app OKLch tokens to dockview CSS variables.
- `defaultLayouts.ts` — per-route default layout objects; restored from localStorage if present.
- `useDockLayout.ts` — hook to persist user-edited layouts to localStorage at `bb.dock.<route>.<userId>`.

**Tradeoffs.** Dockview brings drag-to-reorder, splittable groups, and tab strips out of the box. The cost is bundle size (~50KB gzipped) and a non-trivial CSS theming surface. Considered alternatives:

- **Hand-rolled split-pane (e.g. `react-resizable-panels`).** Cheaper bundle but no tab strips or drag-to-rearrange, and we'd have to design the registry layer ourselves anyway. Rejected for M27.
- **Allotment.** Similar feature set, similar weight, less active maintenance. Rejected.

If bundle size becomes a concern post-launch, the dock is structurally encapsulated behind `Dock.tsx` and the registry — swapping engines later is a localized change.

### Design tokens (M27.2)

`src/index.css` adds a small set of foundational tokens used across all M27 components:

- **OKLch tint backgrounds** derived from base brand colors via `oklch(from var(--primary) l c h / 0.12)` syntax. Tints exist for `primary`, `success`, `warning`, `destructive`, `info`. Used for annotation severity backgrounds, label picker tones, toast variants. Diff coloring continues to follow the rule: blue/purple, never red/green.
- **`.streaming-cursor`** class with a 1Hz blink keyframe. Pause on `prefers-reduced-motion: reduce`. Used by `<StreamingOutputPanel>`, `<LiveLogViewer>`, and the optimizer marker popover.
- **`--panel-header-h`** CSS variable (33px) shared by all panel headers (editor, eval grid, sidebar, dock chrome) so vertical rhythm aligns regardless of which panel is mounted.

---

## Optimizer Meta-Prompt

The scaffolding around this prompt — input/output TypeScript schemas, action-level validation, storage, versioning, evaluation approach, and worked examples — lives in its own doc: [[Blind Bench - Optimizer Meta-Prompt]]. The actual prompt text is a deliberate TODO the owner drafts. Short summary below for convenience; see that doc for everything load-bearing.

> **Inputs:** `currentSystemMessage`, `currentUserTemplate`, `projectVariables`, `outputFeedback[]` (blinded), `promptFeedback[]`, `metaContext[]`
>
> **Outputs (structured JSON):** `newSystemMessage`, `newUserTemplate`, `changesSummary` (markdown bullets), `changesReasoning` (prose, must cite specific feedback items)
>
> The meta-prompt is the core IP of the product. The rest of the system is designed around this input/output shape so the meta-prompt can be iterated on independently.

---

## Key Design Decisions

### 1. Blind Evaluation
Outputs are labeled A/B/C. Evaluators cannot see which version produced which output. Enforced at the Convex function boundary, not in the UI.

### 2. Human-in-the-Loop Optimization
The optimizer suggests, a human accepts / edits / rejects. New versions are never created automatically. This maintains an audit trail and prevents runaway automation.

### 3. Linear Versioning with Rollback Provenance
`v1 → v2 → v3` sequence tracked via `parentVersionId`. Rollback creates a new version (`v4 = copy of v2`) with `parentVersionId = v3` and `sourceVersionId = v2`, preserving both the sequence and the rollback origin. Branching can be added later without migrating existing data.

### 4. Functions-First
Every UI action is a Convex query, mutation, or action — no separate REST layer. The reactive client subscription model makes streaming LLM output and optimization progress essentially free.

### 5. LLM Abstraction Lives in Actions
OpenRouter is only touched inside `runsActions.ts` and `optimizeActions.ts`. A future `convex/lib/llm.ts` module can add Langfuse tracing, LiteLLM routing, or automatic retries without touching any caller.

### 6. Tiptap for Annotations
Tiptap's ProseMirror foundation gives precise text selection. The `from`/`to` positions stored in feedback map directly to the document model. Outputs are immutable once complete, so position stability is not a concern.

### 7. Test Cases Are First-Class
Test cases are project-scoped and reusable across versions. Running the same test case against v1, v2, v3 is the primitive that makes "is v2 actually better than v1?" answerable. Without this, every run is a one-off and comparison is impossible.

### 8. Evaluator Authorization in Functions, Not UI
Blind eval cannot be bypassed client-side. Evaluators literally cannot call any function that would reveal version metadata, because every such function checks role first.

### 9. BYOK Over Platform Key
Each org brings its own OpenRouter key. Ships v1 without billing infrastructure, per-user rate limits, or dollar budgets. Tradeoff: more onboarding friction. The concurrent-run cap is the only guardrail.

### 10. Convex Over Multi-Service Cloudflare
Convex replaces what would otherwise be Workers + D1 + Queues + Durable Objects + KV + R2. Async LLM flows map naturally onto mutation → action → reactive subscription. Real-time collab, when added later, gets document sync for free. Tradeoff: vendor lock-in, centralized regions instead of edge deployment.

---

## v1 Scope & Deferred

### In v1

- Orgs with owner/admin/member membership.
- Projects with owner/editor/evaluator collaborators.
- Project-level variables + first-class test cases.
- Prompt versions (draft / active / archived), rollback with provenance.
- Prompt-level and test-case-level image attachments (vision models).
- Runs with streaming output, 3x fan-out, OpenRouter via BYOK.
- Tiptap feedback on outputs and prompts.
- Optimization requests with human review flow.
- Cross-version comparison on a shared test case.
- Convex Auth (OAuth + magic links).
- Concurrent-run cap as a cost guardrail.

### Deferred (and why)

- **Real-time collaborative editing.** Reactive queries will give us document sync essentially for free when we want it; presence / CRDT cursors can wait. v1 is single-editor-at-a-time with last-write-wins.
- **Langfuse / LiteLLM.** The action-layer seam is preserved; wiring them in is a future PR that touches only `runsActions.ts` / `optimizeActions.ts`.
- **Multi-org admin flows.** Users can create and join orgs; deep admin UX (audit logs, SSO, SCIM) is v2.
- **Billing / pricing tiers.** BYOK sidesteps this entirely for v1.
- **Per-user rate limits and dollar budgets.** Only the concurrent-run cap ships.
- **CLI / CI-CD integrations.** Possible later because everything is a Convex function — a thin HTTP wrapper is all it'd take.
- **Branching versions.** Linear-only for v1; schema leaves room for branches later.

---

## Next Steps

See [[Blind Bench - Build Plan]] for the milestone-level breakdown with deliverables, acceptance criteria, and testable demos. The short form:

1. `npm create convex@latest` + Vite React template + Convex Auth bootstrap.
2. Write `convex/schema.ts` — orgs, members, projects, collaborators, variables, versions, attachments, testCases, runs, outputs, feedback, optimizationRequests, openRouterKeys.
3. BYOK flow — AES-GCM encrypt/decrypt helper, `setKey` + `hasKey` + internal `getDecryptedKey`.
4. Authorization helpers — `requireRole`, `requireOrgRole`, `requireOwner`.
5. CRUD for orgs / projects / variables / versions / test cases.
6. `runsActions.executeRunAction` — OpenRouter streaming + chunk-append pattern.
7. Tiptap editor + annotation feedback (output + prompt).
8. `optimizeActions.runOptimizerAction` + review flow (meta-prompt TBD).
9. Cross-version comparison UI on a shared test case.
10. Landing page on Vercel (separate deployment).

---

## Related

- [[Blind Bench - UX Spec]] — what every screen looks like and how blind eval is closed at the browser-surface layer
- [[Blind Bench - Optimizer Meta-Prompt]] — scaffolding around the optimize action
- [[Blind Bench - Glossary]] — locked vocabulary
- [[Blind Bench - Build Plan]] — milestone-level implementation plan
- [[MOC - Blind Bench]]

---

*Document version: 2.0*
*Last updated: 2026-04-11*
