---
title: "Blind Bench - UX Spec"
created: 2026-04-11
modified: 2026-04-11
type: spec
status: planning
tags:
  - blind-bench
  - ux
  - design
  - spec
---

# Blind Bench — UX Spec

> Part of [[MOC - Blind Bench]]

This is the front-end UX spec. The [[Blind Bench - Architecture]] describes the system layer (data, functions, auth); this doc describes what the user *sees* — every screen, every state, every interaction. The spec is organized screen-catalog-first so an agent can implement screen-by-screen, with cross-cutting concerns (components, states, accessibility, microcopy) factored into their own sections for reference.

Vocabulary is locked in [[Blind Bench - Glossary]]. If a term here doesn't match the glossary, the glossary wins.

---

## Table of contents

1. [Design principles](#1-design-principles)
2. [Information architecture (sitemap)](#2-information-architecture-sitemap)
3. [Role-aware shell](#3-role-aware-shell)
4. [Screen catalog](#4-screen-catalog)
5. [Component inventory](#5-component-inventory)
6. [State catalog](#6-state-catalog)
7. [User flows](#7-user-flows)
8. [Interaction patterns](#8-interaction-patterns)
9. [Empty / error / loading state catalog](#9-empty--error--loading-state-catalog)
10. [Blind eval security rules](#10-blind-eval-security-rules)
11. [Accessibility](#11-accessibility)
12. [Microcopy guide](#12-microcopy-guide)
13. [Keyboard shortcuts](#13-keyboard-shortcuts)
14. [Responsive model](#14-responsive-model)
15. [Onboarding](#15-onboarding)

---

## 1. Design principles

Six opinionated constraints that everything below has to respect.

1. **Desktop-first (1280+).** This is a power tool. Mobile is read-only blind-eval view only; every other route shows a "desktop required" screen under 768px. See [Section 14](#14-responsive-model).
2. **Dense but calm.** Power-tool density with generous vertical rhythm. No cards-in-a-grid-of-cards. Lists beat cards. Tables beat lists where alignment matters. Whitespace beats dividers.
3. **Streaming feels live, not loading.** Outputs fill in via reactive subscriptions the moment chunks arrive. No spinners on streamable endpoints — only skeletons on non-streamable initial loads.
4. **Keyboard-first where reasonable.** Every frequently-used path has a shortcut, and `⌘K` opens a command palette that can reach every screen in two keystrokes.
5. **Blind-eval is a security surface, not a UX convenience.** The UI avoids leaking version info through every browser surface — URL, page title, breadcrumb, tooltip, tab title, favicon, network response, clipboard, `view-source`. Evaluators are the most constrained users in the app; see [Section 10](#10-blind-eval-security-rules).
6. **The annotation is the primary verb.** The Tiptap select-to-comment interaction is the most-used action in the product and gets the highest-affordance treatment. Annotations are immediately visible, immediately editable (if yours), and never more than two clicks away.

---

## 2. Information architecture (sitemap)

```
/                                              → redirects to /orgs/:defaultOrgSlug (or /onboarding)
/auth/sign-in                                   → OAuth + magic link entry
/auth/magic-link/callback                       → magic link token exchange
/onboarding                                     → first-run: create your first org
/eval                                           → evaluator inbox (role=evaluator lands here after auth)
/eval/:opaqueRunToken                           → blind evaluator view (only eval route they can visit)
/orgs/:orgSlug                                  → org home: project list
/orgs/:orgSlug/settings                         → org general settings
/orgs/:orgSlug/settings/members                 → org member + role management
/orgs/:orgSlug/settings/openrouter-key          → BYOK: set / rotate / check status
/orgs/:orgSlug/projects/:projectId              → project home: current version, recent runs, pending optimizations
/orgs/:orgSlug/projects/:projectId/versions     → version history / timeline
/orgs/:orgSlug/projects/:projectId/versions/:versionId → version editor (system + user template + variables chips + attachments + config + Run)
/orgs/:orgSlug/projects/:projectId/variables    → project variable manager
/orgs/:orgSlug/projects/:projectId/test-cases   → test case manager
/orgs/:orgSlug/projects/:projectId/test-cases/:testCaseId → test case editor
/orgs/:orgSlug/projects/:projectId/meta-context → meta-context Q&A editor (Owner only)
/orgs/:orgSlug/projects/:projectId/runs/:runId  → run detail (editor/owner — full metadata + outputs + feedback)
/orgs/:orgSlug/projects/:projectId/compare      → cross-version comparison
/orgs/:orgSlug/projects/:projectId/optimizations/:requestId → optimization review (old vs new diff + changes + accept/reject)
/orgs/:orgSlug/projects/:projectId/settings     → project general settings
/orgs/:orgSlug/projects/:projectId/settings/collaborators → project collaborator invite + role management
/profile                                        → user profile / session settings
/404                                            → not found
/denied                                         → permission denied
```

**Why `/eval/:opaqueRunToken` is separate from the editor routes.** The blind eval route never contains `versionId`, `projectId`, or `runId` in the URL. The token is a short-lived server-signed string that Convex resolves server-side to a runId + evaluator authorization check. If an evaluator copy-pastes the URL, they leak only the opaque token (which expires). If they're also authorized as Editor on the project, [Rule 7 in Section 10](#10-blind-eval-security-rules) blocks them from the eval route entirely.

---

## 3. Role-aware shell

The application shell (top bar + side nav + main content) differs by role.

### Owner / Editor shell

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Org switcher ▾]   Blind Bench                        [⌘K]  [User ▾]   │  ← top bar
├─────────────────┬────────────────────────────────────────────────────────┤
│                 │                                                         │
│ PROJECTS        │                                                         │
│ • My prompt     │                                                         │
│ • Onboarding    │              MAIN CONTENT                                │
│ • Classifier    │                                                         │
│                 │                                                         │
│ — — — —         │                                                         │
│ + New project   │                                                         │
│                 │                                                         │
│                 │                                                         │
│ ORG SETTINGS    │                                                         │
│ • Members       │                                                         │
│ • OpenRouter    │                                                         │
│                 │                                                         │
└─────────────────┴────────────────────────────────────────────────────────┘
```

Within a project, a secondary nav appears as tabs at the top of the main content area:

```
Editor  Versions  Runs  Test Cases  Variables  Meta Context  Compare  Settings
```

### Evaluator shell

> **M26 scope.** This section describes the **blind reviewer** shell (`role === "evaluator"`, `blindMode === true` or absent). Open reviewers (`blindMode === false`) get a different surface — the simplified reviewer dashboard at `/review/:projectId`, covered in [Open Review](#open-review--non-blind-reviewer-surface). Wherever the rules below talk about "evaluator", read it as "blind reviewer".

Radically stripped. No org switcher, no project sidebar, no secondary tabs. The shell shows only:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Blind Bench  —  Evaluation                                  [User ▾]   │  ← top bar
└──────────────────────────────────────────────────────────────────────────┘
```

The top bar does **not** show the project name on the `/eval` inbox (the inbox shows each item's project name inline, once, so blind reviewers can orient without leaking version info globally). On `/eval/:opaqueRunToken`, the top bar shows `"Evaluation — {project name}"` with no version, no run ID, no breadcrumb beyond that string.

Blind reviewers signed in with any other role on a project see that project through its normal Owner/Editor shell. You cannot be blinded to information you already have (see [Rule 7 in Section 10](#10-blind-eval-security-rules)).

---

## 4. Screen catalog

Each screen entry has: **route**, **roles**, **purpose**, **layout**, **primary actions**, **secondary actions**, **states** (from [Section 6](#6-state-catalog)), **transitions out**, **blind-eval rules** (if applicable), **shortcuts** (if applicable).

### 4.1 Landing / marketing
- **Route**: `/` (when not authenticated) — actually served from a separate Vercel deployment in [[Blind Bench - Build Plan]] M7; mentioned here for completeness.
- **Roles**: Anonymous.
- **Purpose**: Explain what Blind Bench is and funnel to sign-in.
- **Layout**: Hero headline + tagline + "Sign in" button + short section explaining the collaborative prompt eval loop.
- **Primary actions**: Sign in.
- **States**: Populated only (static page).
- **Transitions out**: `/auth/sign-in`.

### 4.2 Sign in
- **Route**: `/auth/sign-in`.
- **Roles**: Anonymous.
- **Purpose**: Authenticate via Google OAuth or magic link email.
- **Layout**: Centered single-column card. Logo at top, headline ("Sign in to Blind Bench"), Google button, horizontal rule with "or" label, email input + "Send magic link" button, tiny footer with "What is this?" link to landing.
- **Primary actions**: Google sign-in, send magic link.
- **States**: Loading (during OAuth redirect), Error (OAuth failed, email invalid, rate-limited), Populated.
- **Transitions out**: `/onboarding` (no org yet), `/orgs/:orgSlug` (default org exists), `/eval` (evaluator role only).

### 4.3 Magic link callback
- **Route**: `/auth/magic-link/callback?token=...`.
- **Purpose**: Exchange the token for a session and redirect.
- **Layout**: Spinner + "Signing you in..." text.
- **States**: Loading, Error (token expired / invalid).
- **Transitions out**: Same as sign-in success.

### 4.4 First-run onboarding
- **Route**: `/onboarding`.
- **Roles**: Authenticated, no org membership.
- **Purpose**: Create the user's first organization.
- **Layout**: Centered card. Headline ("Create your workspace"), input for org name, derived slug preview below the input, "Create" button.
- **Primary actions**: Create org.
- **Secondary actions**: Sign out.
- **States**: Populated, Loading, Error (slug collision).
- **Transitions out**: `/orgs/:orgSlug` (freshly created) → automatic prompt to set OpenRouter key.

### 4.5 Org home / project list
- **Route**: `/orgs/:orgSlug`.
- **Roles**: Org member with at least one project, OR Owner/Editor on at least one project in the org.
- **Purpose**: Land here after auth. Show projects and get to work.
- **Layout**: Full shell (Owner/Editor shell from [Section 3](#3-role-aware-shell)). Main content: "Projects" heading + "New project" button top-right, then a dense list (not grid). Each row: project name, current version pill (`v3 · active`), last run timestamp ("Run 2h ago"), collaborator avatars (max 5 + "+N"), chevron.
- **Primary actions**: Open a project, new project.
- **Secondary actions**: Archive project (hover), star project (future).
- **States**: Empty ("No projects yet. Create your first project to start drafting prompts."), Loading (skeleton rows), Populated.
- **Transitions out**: `/orgs/:orgSlug/projects/:projectId`, `/orgs/:orgSlug/projects/new` (modal).
- **Shortcuts**: `⌘K` palette, `N` to create a new project, `↑/↓` to select, `Enter` to open.

### 4.6 Org settings → general
- **Route**: `/orgs/:orgSlug/settings`.
- **Roles**: Owner.
- **Purpose**: Rename the org, update the slug, upload a logo.
- **Layout**: Two-column form. Left: form fields (name, slug, logo uploader). Right: a danger zone card at the bottom ("Delete organization").
- **Primary actions**: Save.
- **States**: Populated, Saving, Error (slug collision).

### 4.7 Org settings → members
- **Route**: `/orgs/:orgSlug/settings/members`.
- **Roles**: Owner.
- **Purpose**: Invite + manage org members.
- **Layout**: "Invite member" input (email) with role picker (owner/admin/member) and "Send invite" button on top. Below: a table of current members (avatar, name, email, role, joined, actions).
- **Primary actions**: Invite member, change role, remove member.
- **States**: Populated, Loading, Error (user already exists, invite failed).

### 4.8 Org settings → OpenRouter key (BYOK)
- **Route**: `/orgs/:orgSlug/settings/openrouter-key`.
- **Roles**: Owner.
- **Purpose**: Set or rotate the org's OpenRouter API key. The key is never shown back to the user; this screen shows presence only.
- **Layout**: Single centered card. Headline ("OpenRouter API key"), status line ("Key set · last rotated 2d ago" OR "No key set"), a masked input (always empty) labelled "New key", "Save key" button, and a tiny help section with a link to OpenRouter's dashboard.
- **Primary actions**: Save key.
- **Secondary actions**: None (no "reveal key" — the backend literally cannot return it).
- **States**: Populated (has key), Empty (no key), Saving, Error (encryption failed, key invalid format).
- **Transitions out**: Back to org home.

### 4.9 Project home
- **Route**: `/orgs/:orgSlug/projects/:projectId`.
- **Roles**: Owner, Editor.
- **Purpose**: The project dashboard. Summarize state, point at next actions.
- **Layout**: Project title + secondary nav at the top. Main content is a 2/3 + 1/3 split:
  - **Left (2/3)**: "Current version" card (version number, status pill, diff-stat vs parent, "Edit" button); below it, "Recent runs" list (5 most recent runs with timestamp, test case name, model, status pill, 3 blind-label mini-previews).
  - **Right (1/3)**: Collaborators list (avatars with role badges), pending optimization requests count with link, meta-context completeness ("3 of 3 questions answered"), BYOK status ("Key set" / "No key — set one").
- **Primary actions**: Edit current version, view recent run, request optimization (if feedback exists).
- **Secondary actions**: View all versions, view all runs, invite collaborator.
- **States**: Populated, Empty (new project with no versions — shows a "Draft your first prompt" CTA that jumps to the version editor).

### 4.10 Version list / history
- **Route**: `/orgs/:orgSlug/projects/:projectId/versions`.
- **Roles**: Owner, Editor.
- **Purpose**: Browse every version of the prompt with provenance.
- **Layout**: Left-rail vertical timeline. Each version is a node: version number badge, status pill, created timestamp, creator avatar, one-line `changesSummary` from the linked optimization request (if any). Edges between nodes render `parentVersionId`; rollback nodes additionally show a dashed edge to `sourceVersionId` with a "rolled back from v2" label. Clicking a node opens it in the version editor.
- **Primary actions**: Open version, rollback to version.
- **Secondary actions**: Archive, duplicate as draft.
- **States**: Populated, Empty.
- **Shortcuts**: `J/K` to move between versions in the timeline.

### 4.11 Version editor
- **Route**: `/orgs/:orgSlug/projects/:projectId/versions/:versionId`.
- **Roles**: Owner, Editor.
- **Purpose**: Write the system message and user template, pick a model, pick a test case, run the prompt.
- **Layout**: Three-column.
  - **Left (20%)**: Variable list (project-scoped) with drag-reorder handles. Each variable: name, description tooltip, default value, required flag. Click `+` to add; click a variable to edit in a popover. Dropping a variable into the template inserts `{{name}}`.
  - **Center (55%)**: Tiptap editor split into two stacked panes:
    - **System message** (optional, collapsible if empty). Renders Mustache `{{chips}}` inline.
    - **User message template** (required). Same rendering.
    - Both panes share selection-to-comment for [prompt feedback](#82-prompt-feedback-annotations).
    - Below the panes: attachment tray (prompt-level attachments — thumbnails + drag reorder + upload button).
  - **Right (25%)**: Run config + run button.
    - Test case dropdown (from the project's test cases).
    - Model dropdown (`<ModelPicker>` with vision filter if attachments exist).
    - Temperature slider.
    - Max tokens input.
    - Run count input (default 3).
    - "More" disclosure: seed, top-p, stop sequences (hidden by default).
    - **[Run prompt]** button — disabled if draft has a validation error, if no test case is selected, if no OpenRouter key is set, or if the concurrent-run cap is reached.
    - Below the run button: "Recent runs for this version" (3 most recent, compact).
- **Primary actions**: Save draft, run prompt, promote draft to active.
- **Secondary actions**: Duplicate as draft, archive version, delete (draft only).
- **States**: Populated, Saving, Validation error (missing variable, unsupported syntax), Streaming (if a run is in progress from this screen), Read-only (archived or active+viewing history).
- **Transitions out**: Run execution view (`/runs/:runId`), version list, test case manager.
- **Shortcuts**: `⌘Enter` to run, `⌘S` to save draft, `C` to comment on selection, `⌘R` to request optimization.

### 4.12 Variable manager
- **Route**: `/orgs/:orgSlug/projects/:projectId/variables`.
- **Roles**: Owner, Editor.
- **Purpose**: CRUD for project variables independent of the version editor.
- **Layout**: Simple table. Columns: Name, Description, Default value, Required, Used in (list of version numbers), Actions. Drag handle on the left for reorder. "Add variable" button top-right.
- **Primary actions**: Add, edit, delete, reorder.
- **States**: Populated, Empty.

### 4.13 Test case manager
- **Route**: `/orgs/:orgSlug/projects/:projectId/test-cases`.
- **Roles**: Owner, Editor.
- **Purpose**: CRUD for test cases. List view.
- **Layout**: Left-rail list of test cases (name, variable count, attachment count). Right pane: preview of the selected test case — variable name/value table, attachment thumbnails. "+ New test case" button above the list.
- **Primary actions**: Create, open in editor, duplicate, delete.
- **Secondary actions**: Reorder.
- **States**: Populated, Empty.

### 4.14 Test case editor
- **Route**: `/orgs/:orgSlug/projects/:projectId/test-cases/:testCaseId`.
- **Roles**: Owner, Editor.
- **Purpose**: Edit a single test case.
- **Layout**: Top: test case name input. Middle: a form where each row is a project variable with its value for this test case (pre-filled with the variable's `defaultValue` if present). Bottom: attachment tray (test-case-level attachments — upload, reorder, delete). Save button bottom-right.
- **Primary actions**: Save.
- **States**: Populated, Saving, Error.

### 4.15 Meta context Q&A editor
- **Route**: `/orgs/:orgSlug/projects/:projectId/meta-context`.
- **Roles**: **Owner only**.
- **Purpose**: Answer the meta-prompting context questions that feed the optimizer.
- **Layout**: Stack of question/answer pairs. Each row: question on the left (bold), answer on the right (textarea), reorder handle. "Add question" button at the bottom. A side panel on the right shows suggested questions ("What domain?", "What tone?", "Who is the end user?", "What should the model never do?") that can be added with one click.
- **Primary actions**: Add, edit, save, remove a question.
- **States**: Populated, Empty ("Meta context feeds the optimizer. Add at least one question before your first optimization to ground the rewrite in your project's intent.").

### 4.16 Run execution view (streaming)
- **Route**: `/orgs/:orgSlug/projects/:projectId/runs/:runId` immediately after clicking Run.
- **Roles**: Owner, Editor.
- **Purpose**: Watch outputs stream in live and see them finalize.
- **Layout**: Header with run metadata (version, test case name, model, temperature, triggered by, started at). Below: a three-column grid (for `runCount=3`). Each column is a `<StreamingOutputPanel>` with:
  - Blind label badge at the top left (`A`, `B`, `C`).
  - `<RunStatusPill>` at the top right (`pending` → `running` → `completed` / `failed`).
  - The output text, filling in live via a reactive subscription on `runOutputs`.
  - A subtle `▋` cursor at the tail of the text until `status: completed`.
  - On completion: token counts, latency, a "Leave feedback" button that opens the Tiptap annotation mode on this panel.
  - On failure: the error message in red, a "Retry this output" button.
- **Primary actions**: Leave feedback, retry, run again, go back to editor.
- **Secondary actions**: Copy output text, expand to full-screen panel.
- **States**: Streaming, Populated, Error (all three outputs failed).
- **Transitions out**: Run detail (same route; it's the same page), editor.
- **Shortcuts**: `J/K` to cycle focused output, `C` to comment on selection in the focused output.

### 4.17 Run detail (editor/owner view)
- **Route**: same as 4.16 after completion.
- **Roles**: Owner, Editor.
- **Purpose**: Review a completed run with full metadata and all feedback.
- **Layout**: Same structure as 4.16 but fully populated. Below the three output panels: an "All feedback on this run" list grouped by output, plus a "Prompt feedback on this version" link at the top.
- **Primary actions**: Leave feedback, request optimization, compare across versions.
- **Secondary actions**: Export run as JSON (debug), delete run.

### 4.18 Output viewer with Tiptap annotations
- **Embedded within**: 4.16 run execution view and 4.28 blind evaluator view. Not a standalone route.
- **Purpose**: The central evaluation UI. Select text → comment on it. See existing annotations. Edit your own.
- **Layout**: The output text in a Tiptap editor (read-only for text content, annotatable on top). Existing annotations render as colored highlights. Hovering a highlight shows a tooltip with the author name (if not evaluator view) and the comment. Clicking opens a side panel with the annotation thread (comment, edit button if yours, delete button if yours).
- **Primary interaction**: Select → comment button fades in at the selection end → click → popover with textarea + Submit → annotation persists → highlight remains. See [Section 8.1](#81-tiptap-comment-on-selection) for the detailed pattern.
- **States**: Read-only (no feedback yet), Populated (annotations visible), Editing (a comment is in-flight).

### 4.19 Prompt feedback view
- **Embedded within**: 4.11 version editor when the editor is in "review feedback" mode.
- **Purpose**: Tiptap annotations on the prompt itself (system message and user template).
- **Layout**: Identical to the version editor but read-only; the two Tiptap panes are annotatable in the same way as output viewer. Switching into this mode is a toggle at the top of the editor ("View feedback" / "Back to editing").

### 4.20 Feedback viewer
- **Route**: reached from the version editor or run detail via a "All feedback" link; does not have its own primary URL in v1 (opens in a modal side-sheet).
- **Purpose**: Aggregated list of every output feedback + prompt feedback item for a version.
- **Layout**: Sheet sliding in from the right edge. Tabs at the top: `Output feedback` · `Prompt feedback`. List of entries, each showing: author, timestamp, target (which output / which field), highlighted text (quoted), comment. Clicking an entry jumps to that annotation in the relevant editor.

### 4.21 Optimization request (trigger + waiting)
- **Route**: `/orgs/:orgSlug/projects/:projectId/optimizations/:requestId`.
- **Roles**: Owner, Editor.
- **Purpose**: Trigger an optimization and watch it process.
- **Layout**: Full-page. Top: "Optimizing version v3" headline + cancel button. Middle: a live status card (`pending` → `processing` → `completed` / `failed`) with a neutral animation (not a spinner — a soft pulse). Below: a read-only preview of what's being fed to the optimizer ("We're sending: 12 output feedback items, 3 prompt feedback items, 3 meta-context answers") so the user has context while waiting.
- **Primary actions**: Cancel.
- **Transitions out**: Automatically transitions to the review screen (4.22) when `status: completed`; to an error state on `failed`.

### 4.22 Optimization review
- **Route**: same as 4.21 once the request is complete.
- **Roles**: Owner, Editor.
- **Purpose**: Review the proposed new prompt and decide.
- **Layout**: Two columns plus a bottom action bar.
  - **Left**: `<PromptDiff>` between the current version and the proposed new prompt, side-by-side by default (toggle to unified). System message and user template as separate diffs.
  - **Right**: `<ChangesPanel>` rendering `changesSummary` (bulleted markdown) and `changesReasoning` (prose).
  - **Bottom action bar**: `[Reject]` · `[Edit and accept]` · `[Accept]` (primary). "Edit and accept" opens an inline editor pre-populated with the proposed new prompt, letting the user tweak before creating the new version.
- **Primary actions**: Accept, edit and accept, reject.
- **States**: Populated, Saving (during accept), Error (validation failed on the LLM output, per [[Blind Bench - Optimizer Meta-Prompt]] Section 5).
- **Transitions out**: Newly-created version editor (on accept), back to version list (on reject).

### 4.23 Cross-version comparison
- **Route**: `/orgs/:orgSlug/projects/:projectId/compare`.
- **Roles**: Owner, Editor.
- **Purpose**: Run the same test case across multiple versions and compare outputs side by side.
- **Layout**: Top: test case picker (single-select) + version multi-picker (checkboxes, 2–5 versions). Middle: a grid with one column per version. Each column is a run-result panel identical to [Section 4.17](#417-run-detail-editorowner-view) but compact. At the top of each column: version number + changed-from-previous indicator.
- **Primary actions**: Run comparison (executes missing runs in parallel), leave feedback inside any panel.
- **Secondary actions**: Swap test case, add/remove versions.
- **States**: Empty (nothing picked yet), Loading, Streaming (runs still executing), Populated.

### 4.24 Version rollback confirmation
- **Embedded**: modal on top of the version list or version editor.
- **Purpose**: Confirm a rollback with clear provenance language.
- **Layout**: Centered modal. Headline: "Roll back to version 2?". Body: "This creates a new version at the head of the timeline with the content of v2. The timeline will show: v3 (current) → v4 (rolled back from v2)." Buttons: `[Cancel]` · `[Roll back]` (primary).
- **States**: Populated, Saving.

### 4.25 Project settings → general
- **Route**: `/orgs/:orgSlug/projects/:projectId/settings`.
- **Roles**: Owner.
- **Purpose**: Rename, describe, delete project.
- **Layout**: Two-column form (name, description) + danger zone card ("Delete project") at the bottom.
- **Primary actions**: Save, delete.

### 4.26 Project settings → collaborators
- **Route**: `/orgs/:orgSlug/projects/:projectId/settings/collaborators`.
- **Roles**: Owner.
- **Purpose**: Invite + manage project collaborators with Owner/Editor/Evaluator roles.
- **Layout**: Invite row (email input + role picker + Send). Below: a table of current collaborators (avatar, name, email, `<RoleBadge>`, invited by, accepted at, actions). Explicit helper text: "Evaluators can only see blinded outputs and leave feedback. They cannot see versions or know which version produced which output."
- **M26 — Invite dialog `blindMode` toggle.** When the selected role is `project_evaluator` or `cycle_reviewer`, the InviteDialog renders a "Blind review" checkbox (default ON) with helper copy: *"Hides the prompt, model, and version info. Recommended for unbiased rating. Turn off to invite a stakeholder (e.g. PM, legal) who needs full context."* The flag is piped into `invitations.create({ blindMode })` and propagates to `projectCollaborators.blindMode` on accept. The role select label reads "Reviewer" instead of "Evaluator" to match the unified vocabulary; the internal literal stays `evaluator` until a later rename milestone.
- **Primary actions**: Invite, change role, remove.
- **States**: Populated, Empty (only the owner listed).

### 4.27 Blind reviewer inbox
- **Route**: `/eval`.
- **Roles**: Blind reviewer (`role === "evaluator"`, `blindMode === true` or absent — and is the landing page for pure blind reviewers after auth). Open reviewers (`blindMode === false`) land on `/review/:projectId` instead — see [Open Review](#open-review--non-blind-reviewer-surface).
- **Purpose**: List of runs awaiting evaluation.
- **Layout**: Top bar shows only "Blind Bench — Evaluation" (no org name, no project globally). Main content: a list of inbox items. Each item shows:
  - Project name (scoped — only the evaluator's projects).
  - Number of outputs in the run (e.g., "3 outputs").
  - Invited-at timestamp relative ("Invited 2h ago").
  - A status chip: `Pending feedback` or `Feedback submitted`.
- **What is NOT shown**: version number, version name, run ID, model, temperature, test case name (test case names can leak intent), who triggered the run.
- **Primary actions**: Open a run.
- **Secondary actions**: Mark all as skipped (future).
- **States**: Populated, Empty ("You're all caught up. Waiting for new runs.").
- **Transitions out**: `/eval/:opaqueRunToken`.
- **Blind-eval rules applied**: 1, 3, 4, 5, 6, 11, 12 (see [Section 10](#10-blind-eval-security-rules)).

### 4.28 Blind evaluator view
- **Route**: `/eval/:opaqueRunToken`.
- **Roles**: Evaluator.
- **Purpose**: The security-sensitive screen. Show the run's outputs labeled A/B/C and let the evaluator annotate them.
- **Layout**: Top bar: `"Evaluation — {project name}"`. Main content:
  - Above the outputs: a neutral instruction card — "Leave feedback on each output by selecting text and commenting. Outputs are labeled A/B/C to remove bias. Submit when you're done."
  - Three-column grid of outputs, each a `<StreamingOutputPanel>`-turned-`<AnnotatedEditor>` (read-only text, annotatable overlay). Each panel shows only:
    - `<BlindLabelBadge>` ("A" / "B" / "C").
    - The output text.
    - An annotation count badge ("3 comments").
    - A "Leave feedback on this output" affordance (which is just "select text to comment", surfaced by an inline hint the first time).
  - Bottom: a "Submit feedback" button that marks the evaluator's session as complete and optionally auto-advances to the next inbox item.
- **Primary actions**: Annotate text, submit.
- **Secondary actions**: Back to inbox.
- **States**: Populated, Read-only (after submit), Denied (token expired — redirect to `/eval`).
- **Blind-eval rules applied**: ALL 13 rules in [Section 10](#10-blind-eval-security-rules).
- **Shortcuts**: `C` to comment on selection, `J/K` to cycle focus across the three columns, `⌘Enter` to submit comment.

### 4.29 Profile / account
- **Route**: `/profile`.
- **Roles**: Any authenticated user.
- **Purpose**: View name + email, sign out, manage sessions.
- **Layout**: Simple form. Name (editable), email (read-only), avatar (upload), sign-out button, "Sign out everywhere" button.

### 4.30 Error screens
- **Routes**: `/404`, `/denied`, session-expired inline redirect.
- **Layout**: Centered card with a headline matching the error kind, a one-line explanation, and a single CTA back to a sensible place (home for 404, sign-in for session expired, previous page for denied).

---

## 5. Component inventory

Reusable components referenced across the screen catalog. Each is a single well-scoped surface.

- **`<VersionSelector>`** — Dropdown with draft/active/archived groups and a mini-timeline hint showing parent/source-version edges. Used in the version list, run detail, and compare screen.
- **`<ModelPicker>`** — OpenRouter model dropdown with filtering for vision-capable models (auto-filters when any attachment is present on the prompt or test case). Shows model name + provider + context window + vision capability icon.
- **`<VariableChip>`** — Inline chip rendered by the Tiptap editor when the template contains `{{name}}`. Click to edit the variable's default value in a popover. Color-coded by required/optional.
- **`<AttachmentCard>`** — Thumbnail (or filetype icon) + filename + size + delete button. Drag-reorderable. Used for both prompt attachments and test-case attachments.
- **`<StreamingOutputPanel>`** — Renders `outputContent` from a Convex reactive subscription. Chunks append as they arrive; a `▋` cursor at the tail until `status: completed`. Shows status pill, blind label badge, and token counts + latency on completion.
- **`<BlindLabelBadge>`** — Neutral pill with "A" / "B" / "C" / ... Single color, no hover tooltip beyond `aria-label="Output A"`. Used everywhere an evaluator might see an output.
- **`<AnnotatedEditor>`** — Tiptap wrapper with selection-triggered comment bubble, thread side panel, and read-only mode. Renders existing annotations as highlights. Handles the full select → comment → submit → persist loop.
- **`<PromptDiff>`** — Unified or side-by-side diff between two strings, with move detection. Color-blind-safe palette (blue/purple, not red/green). Used in optimization review and version history.
- **`<ChangesPanel>`** — Renders `changesSummary` (markdown bullets) and `changesReasoning` (prose) from an `optimizationRequest`. Pure display.
- **`<MetaContextEditor>`** — Q&A form for `projects.metaContext`. Add/remove/reorder questions; textarea for each answer.
- **`<RunStatusPill>`** — Pill rendering `pending` / `running` / `completed` / `failed` with distinct colors and icons.
- **`<RoleBadge>`** — Owner / Editor / Evaluator pill with distinct colors. Used in collaborator tables and role-change menus.
- **`<ConcurrentRunGauge>`** — Small gauge showing in-flight runs vs the soft cap (e.g., "3 / 10 in flight"). Appears in the version editor's Run button area when runs > 0.
- **`<EmptyState>`** — Illustration slot + headline + description + CTA button. Used across every list view. See [Section 9](#9-empty--error--loading-state-catalog) for the specific copies.
- **`<CommandPalette>`** — `⌘K` fuzzy finder across projects, versions, test cases, runs, and primary actions ("New project", "New test case"). Keyboard-only navigation inside the palette.
- **`<AnnotationToolbar>`** — Floating, draggable comment surface for the eval grid. Hosts `<LabelPicker>` + textarea + submit. See [§8.8](#88-annotation-toolbar-floating-draggable). Falls back to a bottom-sheet on touch / narrow viewports.
- **`<LabelPicker>`** — Conventional-comments-style label picker with six categories (suggestion / issue / praise / question / nitpick / thought). Tonal pill, OKLch-derived tint background. See [§8.10](#810-conventional-label-picker).
- **`<OptimizerMarker>`** — Sparkle gutter marker on lines the optimizer changed. Click → popover with per-change rationale. See [§8.9](#89-optimizer-markers-inline-sparkles).
- **`<OptimizerHistory>`** — Sidebar/dock panel listing all optimizer runs for the current version, scroll-faded. See [§8.9](#89-optimizer-markers-inline-sparkles).
- **`<LiveLogViewer>`** — Streaming pre-formatted output with smart auto-scroll (sticks to bottom unless user scrolls up). Shows a "Jump to bottom" pill on user scroll. Truncates oversized logs with a marker. Uses the `.streaming-cursor` token while live.
- **`<OnboardingTour>`** — Multi-step first-run dialog with staggered spring animations. See [§8.12](#812-first-run-onboarding-tour).
- **`<CountBadge>`** — Compact monospace badge for counts on tabs and headers (annotation count, eval column count, inbox count). Variants: `default`, `subtle`, `accent`.
- **`<CopyButton>`** — Icon button with a 1.5s "Copied" flash. Variants: `overlay` (absolutely positioned over a code block) and `inline`. Falls back to a textarea-selection method when `navigator.clipboard` is unavailable (non-HTTPS contexts).
- **`<ScrollFade>`** — Wrapper that renders top/bottom gradient masks when child content overflows. Uses `ResizeObserver` + scroll listener; respects `prefers-reduced-motion` (instant show/hide).

---

## 6. State catalog

Every screen references states by name from this list. Implementing a state once and using it everywhere keeps the product feeling consistent.

- **Loading** — Skeleton shimmer, not a spinner. For initial data fetches; transitions to `Populated` or `Error: *` when the reactive query resolves. Always has a specific skeleton shape matching the target layout (not a generic grey box).
- **Empty** — A first-time or zero-state view. Always has a specific component copy (see [Section 9](#9-empty--error--loading-state-catalog)), not a generic "no data".
- **Error: auth** — Session expired or not authenticated. Immediate redirect to `/auth/sign-in` with a `redirect=` query param so the user lands back where they were after signing in.
- **Error: permission** — Authenticated but not authorized for this resource. Full-screen "You don't have access to this" + a "Back" button. Never reveal whether the resource exists or is simply hidden.
- **Error: network** — Can't reach Convex. Inline banner ("Couldn't reach Convex. [Retry]") at the top of the affected area. Doesn't block the rest of the page.
- **Error: notFound** — 404. Full-screen "Not found" + a CTA back to the user's default org.
- **Streaming** — A run is in progress. The affected area renders `<StreamingOutputPanel>`s. Interactive controls that could interrupt the stream (cancel, retry, navigate away with unsaved edits) are disabled until the stream completes or fails.
- **Populated** — The happy path.
- **ReadOnly** — Used for evaluators, for finalized outputs, and for archived versions. All mutation affordances are hidden (not disabled — hidden, so the UI doesn't hint at permissions the user doesn't have).

Error states are always distinguishable from each other. "Something went wrong" is banned copy.

---

## 7. User flows

Six end-to-end journeys that cross multiple screens. Each flow is written as a numbered sequence with decision points.

### 7.1 First-run onboarding flow

1. User arrives at `/` → no session → redirected to `/auth/sign-in`.
2. User signs in with Google.
3. No org membership exists → redirected to `/onboarding`.
4. User enters org name → submits → org created → redirected to `/orgs/:orgSlug`.
5. Org home shows an empty projects list with a prominent inline blocker: **"Set your OpenRouter key to start running prompts"** pointing at `/orgs/:orgSlug/settings/openrouter-key`.
6. User clicks through, sets key, returns to org home.
7. User clicks "New project" → modal asks for project name + optional description → creates project → redirected to `/orgs/:orgSlug/projects/:projectId`.
8. Project home shows an empty state: **"Draft your first prompt"** CTA → user clicks → redirected to version editor with a new draft pre-created (`v1`, status `draft`).
9. Version editor shows inline callouts the first time: "Add a variable", "Write your user template", "Add a test case", "Click Run".
10. User adds a variable, writes `Translate the following to Spanish: {{text}}`, clicks "Add test case", switches to test case editor, fills in `text` value, returns to editor.
11. User picks a model, clicks **Run prompt** (`⌘Enter`) → redirected to run execution view.
12. Outputs stream in live across three columns.
13. User leaves an annotation on Output B ("This is too literal").
14. User clicks **Request optimization** → waiting screen → review screen.
15. User accepts the new version → redirected to new version editor (v2).
16. User clicks "Invite collaborator" in the right-hand project sidebar → invites two people: one as Editor, one as Evaluator.

### 7.2 Evaluator flow

1. Evaluator receives an email invitation (magic link).
2. Clicks link → `/auth/magic-link/callback` → session created.
3. User's only role is Evaluator on a single project → automatically redirected to `/eval`.
4. Inbox shows one item: project name, "3 outputs", "Invited 2h ago", "Pending feedback". **No** version, model, test case name.
5. Evaluator clicks the item → navigates to `/eval/:opaqueRunToken`.
6. View shows `"Evaluation — {project name}"` in top bar + instruction card + three output columns with A/B/C badges.
7. Evaluator selects a phrase in Output A → comment bubble fades in → clicks → textarea popover → types comment → Submit.
8. Annotation persists as a highlight. Repeats across outputs.
9. Evaluator clicks **Submit feedback** → run marked evaluated → inbox auto-advances to the next item (or empty state).
10. At any point, hitting back or trying to visit any other route bounces the evaluator back to `/eval`.

### 7.3 Optimization flow

1. Editor has collected feedback across a version's runs and prompt.
2. From the version editor OR the feedback viewer sheet, editor clicks **Request optimization** (`⌘R`).
3. Confirmation modal: "Optimize version v3? This reads all feedback and meta-context and proposes a new prompt. You'll review before anything is saved."
4. Click Optimize → new `optimizationRequest` created → navigates to `/orgs/:orgSlug/projects/:projectId/optimizations/:requestId`.
5. Waiting screen shows input preview ("Sending: 12 output feedback items, 3 prompt feedback items, 3 meta context answers") + soft-pulsing status card.
6. Convex action completes → status flips to `completed` → screen auto-transitions to the review layout.
7. Review screen shows old-vs-new diff on the left and `changesSummary` + `changesReasoning` on the right.
8. Editor reads the reasoning, reviews the diff, clicks **Accept**.
9. New version created → redirected to the new version editor.

Failure branch: if the LLM output fails validation (per [[Blind Bench - Optimizer Meta-Prompt]] Section 5), the review screen shows the error message and a "Try again" button instead of the diff.

### 7.4 Cross-version comparison flow

1. From project home or the Compare tab, user lands on `/orgs/:orgSlug/projects/:projectId/compare`.
2. Test case picker + version multi-picker. Empty state: "Pick a test case and at least two versions to compare."
3. User picks test case "short-input" + checks versions v1, v2, v3.
4. User clicks **Run comparison** → the system schedules runs for any (testCase, version) pair that doesn't already have a recent run; existing runs are reused.
5. Three-column grid appears with panels streaming in. Each column has the version number at the top.
6. User spot-reads the outputs and leaves an annotation in the v2 column.
7. Annotations are written against the specific run that produced the output (so they're tied to a version, not to the comparison view).

### 7.5 Rollback flow

1. User is unhappy with v3 → navigates to version list.
2. Scrolls the timeline, clicks v2.
3. Version list shows v2's content and a **Roll back to v2** button.
4. Click → confirmation modal with explicit language: "This creates a new version at the head of the timeline with the content of v2. The timeline will show: v3 (current) → v4 (rolled back from v2)."
5. Confirm → `versions.rollback` mutation → new version v4 created with `parentVersionId = v3` and `sourceVersionId = v2`.
6. Redirected to v4 in the editor, which renders a provenance badge "rolled back from v2".

### 7.6 BYOK blocker flow

1. User tries to click **Run prompt** on a version with no OpenRouter key set for the org.
2. Run button is disabled with a tooltip: "No OpenRouter key set. Set one to run prompts."
3. Clicking the disabled button shows an inline callout below it: "**Set your OpenRouter key →** [link to /orgs/:orgSlug/settings/openrouter-key]".
4. User clicks through, sets the key, returns. (Browser back OR the "Return" CTA on the BYOK screen returns to the exact version editor URL.)
5. Run button is now enabled → user clicks Run.

---

## 8. Interaction patterns

High-leverage interactions that need specific definition.

### 8.1 Tiptap comment-on-selection

The core annotation interaction. Used in [[#4.18 Output viewer with Tiptap annotations]], [[#4.19 Prompt feedback view]], and [[#4.28 Blind evaluator view]].

1. User selects text via click-drag or shift+arrow.
2. A small floating comment button (`💬 + Comment`, or an icon-only button with `aria-label="Add comment"`) fades in at the trailing end of the selection, anchored to the viewport coordinates of the selection rect.
3. Clicking the button opens a popover anchored to the selection:
   - Textarea (autofocused).
   - Submit button (primary, disabled until non-empty).
   - Cancel button or Esc.
4. On Submit (`⌘Enter`), a new `outputFeedback` or `promptFeedback` row is inserted via a Convex mutation. The mutation writes the Tiptap `{from, to, highlightedText, comment}`.
5. The annotation persists as a colored highlight on the same range. The popover closes.
6. Hovering any highlight opens a tooltip-ish hover card with the comment text (and author name, except in evaluator view). Clicking opens a thread side panel with full edit/delete affordances if the current user is the author.

**Blind eval constraint.** In evaluator view, the hover card never shows the author's name. Only the comment text.

### 8.2 Prompt feedback annotations

Identical mechanics to output feedback but scoped to a version's `systemMessage` or `userMessageTemplate`. The only difference is the `targetField` discriminator on the stored annotation and the fact that these feedback items don't need blind labels — the commenter can always see the prompt they're annotating (only editors and owners leave prompt feedback).

### 8.3 Streaming output render

- Chunks arrive from `runs.appendOutputChunk` and are appended to `runOutputs.outputContent`.
- The Convex reactive subscription causes the `<StreamingOutputPanel>` to re-render.
- Text jumps in at natural chunk boundaries — **no** typewriter animation. Typewriter animations are slower than the actual data and imply a fake loading effect. We want "live".
- A `▋` cursor character is appended at the tail of the rendered text (via CSS `::after` on the last text node) until `runOutputs.status === 'completed' || 'failed'`.
- `prefers-reduced-motion` pauses the cursor blink.
- When the stream completes, the cursor disappears, the status pill flips to `completed`, and the token counts and latency fade in below the text (one-frame fade, not a bounce).

### 8.4 Diff view

- Default: side-by-side. Toggle to unified.
- Colors: blue for the "new" side, purple for the "old" side. **No red/green.** Color-blind safe and avoids implying "red = bad".
- Moves detected and highlighted in a third color (teal) with a "moved" icon rather than as paired delete+add.
- Gutter shows line numbers in the old version, line numbers in the new version, and a change marker (`+`, `-`, `~`).
- Clicking a change highlights the corresponding location in the `changesReasoning` panel (in the optimization review screen).

### 8.5 Drafts vs active vs archived

- **Draft**: editor has a dashed border. Header pill shows "DRAFT" in muted color. Run button enabled.
- **Active**: solid border. Header pill shows "ACTIVE v3" in an accent color. Run button enabled. Editing is blocked — edits require creating a new draft from this version.
- **Archived**: solid muted border. Header pill shows "ARCHIVED v2". Run button disabled. Editing blocked. Used for viewing historical versions.
- **Rolled back**: same border as Active + a small provenance badge "from v2" next to the version number.

### 8.6 Error surfacing

- **Validation errors** (bad template syntax, missing variable) → inline, near the field that caused the error. Never a toast.
- **Ephemeral errors** (save failed, retry worked) → toast in the lower-right. Auto-dismiss after 5s.
- **Auth / permission errors** → full-screen error view with a sensible CTA. Never inline.
- **Network errors** → inline banner at the top of the affected area with a retry.
- **Confirmation of destructive actions** → modal with explicit consequence language. Never a toast.

### 8.7 Concurrent run cap feedback

When the project is at the soft cap:
- The Run button shows a tooltip: "10 runs in flight. Wait for one to finish before starting another."
- `<ConcurrentRunGauge>` at the top of the editor's right pane shows "10 / 10" with a warning color.
- The mutation will also throw on the server side; the client catches this and re-surfaces the same message.

### 8.8 Annotation toolbar (floating, draggable)

The select-to-comment surface in the eval grid uses a floating toolbar instead of an anchored popover. Reason: grid cells are narrow, and an anchored popover occludes the very text being annotated.

- **Spawn.** When a reviewer makes a text selection inside an output cell of the eval grid, `<AnnotationToolbar>` fades in near the trailing end of the selection (within ~12px). On touch devices and viewports < 768px the toolbar is replaced by a bottom-sheet modal (no drag).
- **Drag handle.** The toolbar header is the drag handle. Cursor: `grab` → `grabbing` on press. Pointer events (so it works with mouse + pen + touch+keyboard equally). The toolbar is constrained to the viewport — it cannot be dragged off-screen.
- **Position memory.** Last-used position is held in component state for the session only. **Not** localStorage — fresh page loads recenter on the next selection. A session-scoped position is enough to keep the toolbar out of the way as the user moves down a long output.
- **Body.** Header (drag handle + close button) → `<LabelPicker>` (see [§8.10](#810-conventional-label-picker)) → comment textarea (autofocused) → submit + cancel.
- **Keyboard.** `Esc` closes; `Cmd/Ctrl+Enter` submits; `Tab` cycles header → label picker → textarea → submit.
- **Reduced motion.** Open/close fades, no spring; drag is unaffected.
- **Blind-eval rule audit.** The toolbar DOM contains zero `data-version-id`, `data-run-id`, or any attribute carrying a real ID. Submission goes through the same opaque-token mutation as the existing inline annotation flow. Snapshot test in §10.

### 8.9 Optimizer markers (inline sparkles)

Inline markers indicate which lines in the current version were touched by the optimizer. They are the analogue of "AI-touched" markers in collaborative editors, scoped to the structured optimizer surface — Blind Bench has **no** free-form "Ask AI" chat.

- **Visual.** A small sparkle icon (`✦` or Lucide `Sparkles`) rendered in the editor gutter on every line range present in the active optimizer run's `changes[].range`. Hairline-thin so it does not steal attention from the prompt text.
- **States.**
  - *Pending* (optimizer in flight, change emitted): pulse animation; respects `prefers-reduced-motion`.
  - *Settled* (optimizer complete): static.
  - *Hovered/focused*: subtle highlight on the corresponding line range.
- **Click → popover.** Anchored to the marker. Shows the per-change `rationale` (one paragraph, from the structured optimizer output) and a "View full optimization run" link to the optimization detail screen.
- **Count badge.** The number of marked lines on a version surfaces as a `<CountBadge>` on the version tab, so reviewers know at a glance which versions have AI-suggested edits.
- **History thread.** A `<OptimizerHistory>` panel (rendered in the dock per [§8.11](#811-dock-layout)) lists all optimizer runs for the current version, newest first. Each entry: timestamp, model, truncated diff preview, expand-on-click. Wrapped in `<ScrollFade>` for long histories.
- **Streaming cursor.** While an optimizer run is in flight, the previewed text in the popover ends with `.streaming-cursor` (per the streaming token in [§8.3](#83-streaming-output-render)).
- **Blind-eval rule audit.** Markers and history must not render real version IDs. The marker's `data-*` attributes are limited to opaque change indices (`data-change-idx`). The history panel uses the same opaque tokens used elsewhere on the eval surface; for evaluators, the optimizer panel is hidden entirely (it is editor/owner-only).

### 8.10 Conventional label picker

Annotation comments carry a typed label drawn from a fixed taxonomy. The label is structured signal for the optimizer (e.g., "praise" and "issue" weight differently) and shared vocabulary for reviewers.

| Label | Tone | Semantic |
|---|---|---|
| suggestion | info | Recommend a change |
| issue | warning | Something wrong |
| praise | success | Positive signal |
| question | info | Needs clarification |
| nitpick | muted | Minor, non-blocking |
| thought | muted | Musing, not actionable |

- **Component.** `<LabelPicker>` rendered inside `<AnnotationToolbar>` and inside the existing inline annotation popover. Active label is shown as a tonal pill; tone background derives from the OKLch tint tokens (no red/green per the design rule).
- **Default.** New annotations default to `thought` (most neutral). Existing rows pre-launch default to `thought` per the no-backfill decision.
- **Optional `blocking` flag.** Reserved for future use; the schema supports it but the UI surfaces it only on labels that opt in (`suggestion`, `issue`). Hidden on others.
- **Accessibility.** Each option has an `aria-label` matching the label name; selected state is announced via `aria-selected`. Keyboard navigation: arrow keys cycle, `Enter` selects.
- **Blind-eval rule audit.** Labels are visible to all reviewer roles, but the label name itself does not encode version metadata. Safe.

### 8.11 Dock layout (multi-panel workspace)

The editor, eval grid, annotations, optimizer history, and run logs all compete for screen real estate. The dock lets the user arrange and resize panels per their workflow instead of forcing a single layout.

- **Engine.** `dockview-react`. Theme via CSS variables bridging to existing OKLch tokens; no hex hardcoded into dockview internals.
- **Panel registry.** A typed `PANEL_TYPES` map with one component per type:
  - `EDITOR` — version editor / Tiptap surface
  - `EVAL_GRID` — output grid
  - `ANNOTATIONS` — annotation list for the current run/version
  - `OPTIMIZER_HISTORY` — see [§8.9](#89-optimizer-markers-inline-sparkles)
  - `RUN_LOGS` — `<LiveLogViewer>` over the streaming run
- **Default layouts** (per route, restored from localStorage if present):
  - **Project detail / version editor**: Editor (left, 55%) | Eval grid (right-top) | Annotations (right-bottom tab on the same group)
  - **Run detail**: Editor (left, collapsed to 0% by default) | Run logs (center) | Eval grid (right)
  - **Evaluator session**: Eval grid (full); Annotations only as a right sidebar. Dock chrome simplified — no add-panel menu, no panel close. **Editor / optimizer-history / run-logs are not registered for evaluator sessions.**
- **Chrome.** All panel headers read from the `--panel-header-h` CSS token so vertical rhythm aligns across panels. Non-essential panels have a close button; an "Add panel" affordance lives in the tab strip and is gated by route.
- **Persistence.** User layout is saved per `(userId, route)` to `localStorage` (`bb.dock.<route>.<userId>`). Server-side persistence is out of scope for M27.
- **Keyboard.** Arrow keys cycle through tabs in the focused group. Active panel announces via `aria-live="polite"`.
- **Responsive.** Tablet (≥ 1024px): full dock. Mobile (< 1024px): falls back to a stacked single-column layout (no dock). Evaluator session on mobile already exists today and is unaffected.
- **Blind-eval rule audit.** The evaluator-session registry deliberately excludes any panel that could leak version metadata. The localStorage key namespaces by user, so a user with multiple roles cannot cross-contaminate layouts.

### 8.12 First-run onboarding tour

A guided dialog that compresses the first-run cliff (sign-in → BYOK → project → version → eval) into a single funnel. Replaces the prior plan of inline callouts only when the user is opted into the tour; the inline callouts remain as the lower-friction fallback (see [§15](#15-onboarding)).

- **Trigger.** First sign-in where `users.hasSeenOnboarding === false`. Skippable; resumable from `Settings → Onboarding`.
- **Steps.**
  1. **Welcome.** What Blind Bench is in one paragraph; CTA "Let's set up". Includes a 3-row key-takeaways table with severity badges (frictionless feedback, BYOK, blind-by-default).
  2. **BYOK setup.** Why BYOK (you own your keys, no middleman), where to get a key (link to OpenRouter), and an inline form to paste + save the encrypted key. Until a valid key is saved, `Next` is disabled.
  3. **Create a project.** Inline "Create project" CTA opens the existing dialog.
  4. **Write your first prompt.** Lands in the editor with a sample variable pre-filled.
  5. **Run your first eval.** Lands in the run view with a sample test case.
  6. **Done.** Recap + link to docs; sets `hasSeenOnboarding = true`.
- **Animation.** `motion/react` staggered springs (`stiffness: 220, damping: 24`, 40ms stagger) cascade the title → description → key-takeaways → CTA. `prefers-reduced-motion` disables animation entirely (instant render).
- **Persistence.** `users.hasSeenOnboarding` and `users.onboardingStep` are stored in Convex; reopening the tour mid-flow restores the user to their last step.
- **Blind-eval rule audit.** Tour copy is generic — no project, version, or model name appears in dialog text. Tour does not run on `/eval/*` routes; if a user is invited as a blind reviewer before completing the tour, the eval flow takes priority and the tour is dismissed silently.

---

## 9. Empty / error / loading state catalog

Every zero-state has a specific, actionable copy. "No X found" is banned. Phrasing is "do this next", not "nothing is here".

### Empty states

| Screen | Copy | CTA |
|---|---|---|
| Org home | "No projects yet. Create your first project to start drafting prompts." | New project |
| Project home (new project) | "Draft your first prompt to get started." | Open editor |
| Version editor (no variables) | "Variables appear here. Add one and reference it with `{{name}}` in your template." | Add variable |
| Version editor (no test cases) | "Add a test case to run this prompt." | New test case |
| Version editor (no OpenRouter key) | "Set your OpenRouter key to run prompts." | Set key |
| Test case manager | "Test cases let you run the same prompt against multiple inputs. Create your first." | New test case |
| Variable manager | "Variables are project-scoped placeholders you can reference in any version. Create your first." | Add variable |
| Meta context | "Meta context feeds the optimizer. Add a question before your first optimization to ground the rewrite in your project's intent." | Add question |
| Run detail (no feedback) | "No feedback yet. Select text in any output to leave an annotation." | — |
| Feedback viewer (no feedback) | "No feedback for this version yet." | — |
| Version list (new project) | "v1 will appear here after you save your first draft." | — |
| Compare screen | "Pick a test case and at least two versions to compare." | — |
| Collaborators (just owner) | "You're the only collaborator. Invite someone to start leaving feedback." | Invite |
| Evaluator inbox | "You're all caught up. Waiting for new runs." | — |
| Optimizations list | "No optimization requests yet." | — |

### Error states

| Kind | Copy | CTA |
|---|---|---|
| Session expired | "Your session expired. Sign in to continue." | Sign in |
| Permission denied | "You don't have access to this." | Back |
| Not found (404) | "We couldn't find that page." | Home |
| Couldn't load | "Couldn't load {resource}." | Retry |
| OpenRouter down | "OpenRouter didn't respond. Try again, or check the OpenRouter status page." | Retry |
| Bad OpenRouter key | "OpenRouter rejected your API key. Check it in org settings." | Open key settings |
| Run failed | "Output {blindLabel} failed: {errorMessage}" | Retry output |
| Optimization failed | "The optimizer returned {reason}. Try again, or adjust the meta-prompt." | Try again |
| Concurrent run cap | "10 runs in flight. Wait for one to finish before starting another." | — |
| Template validation | "Unknown variable `{{x}}`. Add it to the project's variables or remove the reference." | — |
| Magic link expired | "This sign-in link expired. Get a new one." | Send another |

### Loading states

- **Org home**: skeleton rows (5) with project-name-length + status-pill-length + avatar-stack-length.
- **Project home**: skeleton of the 2/3 + 1/3 split, current version card + recent runs stubs.
- **Version editor**: skeleton of the three-column layout.
- **Run execution view**: three empty `<StreamingOutputPanel>`s in `pending` state — not a spinner — with "Waiting for OpenRouter..." hint at the center of each column.
- **Optimization waiting**: soft-pulsing card, not a spinner, with the live input preview underneath.

---

## 10. Blind eval security rules

The single most important section of this doc. Every rule is a test that can be run against the built UI to verify that version information does not leak to a **blind reviewer** via a browser surface. The backend enforces blind eval at the Convex function boundary (per [[Blind Bench - Architecture#Authorization Model]]); these rules close the browser-side gap.

> **M26 scope note.** "Blind reviewer" below means a collaborator with `role === "evaluator"` AND `blindMode === true` (or absent). Open reviewers (`blindMode === false`) intentionally see the prompt and outputs in full and are out of scope for these rules — their surface is `/review/:projectId`, covered separately under [Open Review](#open-review--non-blind-reviewer-surface). The canonical gate everywhere is the helper `isBlindReviewer(ctx, projectId)`, never `role === "evaluator"`.

Every rule has an acceptance test format you can run in devtools.

1. **The `/eval/:opaqueRunToken` route is the only route a blind reviewer can visit.** Any other route redirects to `/eval` with no flash of unrendered content. **Test**: sign in as a blind reviewer (`blindMode: true`), paste `/orgs/:orgSlug/projects/:projectId` → should bounce to `/eval` instantly. (Open reviewers go to `/review/:projectId` instead.)
2. **The opaque token is server-generated, short-lived (1 hour), and does not contain `runId`, `versionId`, or `projectId` as substrings.** Generated server-side via `crypto.randomUUID()` or an HMAC. **Test**: decode the token → assert no ID substring matches.
3. **The page `<title>` on the blind-review view is exactly `"Evaluation — {project name}"`.** No version number, version name, or version ID. **Test**: `document.title` on `/eval/:opaqueRunToken` → regex match.
4. **Breadcrumbs on the blind-review view show only "Evaluation".** Not a project → version chain. **Test**: no breadcrumb component rendered at all in the blind-review shell.
5. **The tab favicon is the generic app icon.** Never a project-specific or version-specific icon. **Test**: `link[rel=icon]` href is the default.
6. **Tooltips on output panels show only the blind label.** No hover reveals model, temperature, latency, token count, timestamp, test case name, or trigger user. `<BlindLabelBadge>` has `aria-label="Output A"` and no other tooltip. **Test**: hover every interactive element in the blind-review view → no network request fetches anything beyond `{blindLabel, outputContent, annotations}`.
7. **A user who is also an Editor on the project — or whose `blindMode` was ever `false` for this project — is treated as having seen the prompt and the eval route blocks them.** Shows a full-screen notice: "You're an editor on this project. You cannot participate in blind evaluation here." **You cannot be blinded to information you have already seen.** This means `blindMode` is a one-way street in v1: open → blind is not supported on a live row; the schema only sets it at invite time and the open path persists once accepted. **Test**: assign a user both roles, visit `/eval/:opaqueRunToken`, assert the notice renders.
8. **API responses to the blind reviewer's session endpoints contain only `{ blindLabel, outputContent, annotations }[]`.** No additional fields. The session pipeline (`reviewSessions.*`) is the only path; calls to `runs.get`, `runs.list`, `versions.get`, etc. throw "Permission denied" inline when `isBlindReviewer` is true. **Test**: open devtools network tab on `/eval/:opaqueRunToken`, inspect the response payload, assert no `runId`, `versionId`, `projectId`, `model`, `temperature`, `latencyMs`, `promptTokens`, `completionTokens`, `createdAt`, or any other metadata.
9. **Export / copy-to-clipboard on an output includes only the text content.** Never the source version. The "Copy" button produces plain text, never a rich payload with HTML data-attributes carrying metadata. **Test**: copy an output → paste into a text editor → assert the clipboard contains only the visible text.
10. **Image attachments in vision runs have EXIF metadata stripped before upload.** EXIF can contain camera model, GPS, timestamp — all potential leaks. The client strips EXIF on upload via `canvas`-based re-encoding; the server double-checks and rejects any image with EXIF present. **Test**: upload an image with GPS EXIF → download it back → assert no EXIF on the returned file.
11. **URL share / "copy link" from the blind-review view copies only the `/eval/:opaqueRunToken` URL.** No query params, no fragments, no referrer. **Test**: click the share icon → check clipboard contents.
12. **Manually entering any route under `/orgs/:orgSlug/...` as a blind reviewer redirects to `/eval`.** Redirect is server-side (Convex auth gate) AND client-side (React Router gate). The redirect fires when `isBlindReviewer` returns true on the project; open reviewers fall through. **Test**: paste the URL as a `blindMode: true` collaborator, expect bounce.
13. **View-source and devtools do not reveal version metadata in hidden DOM nodes or data attributes.** No `data-version-id`, no `data-run-id`, no hidden `<script>` blob with the full run object. All metadata stays on the server. **Test**: open devtools elements tab, grep for `data-version`, `data-run`, `version-id`, `run-id` — zero matches.

**Design principle carried forward:** Blind eval is a security surface, not a UX convenience. When in doubt, strip metadata. When extending the eval pipeline, gate on `isBlindReviewer`, never on `role === "evaluator"`.

**M27 surface additions — same rules apply:**

- **Annotation toolbar (§8.8).** Snapshot test: render `<AnnotationToolbar>` inside an evaluator session, grep the rendered HTML for `data-version-id`, `data-run-id`, `version-id`, `run-id` — zero matches. Submission goes through the existing opaque-token annotation mutation; no new ID surface.
- **Optimizer markers (§8.9).** The optimizer panels (`OPTIMIZER_HISTORY`) and inline markers are not registered for evaluator sessions per §8.11. Test: visit `/eval/:opaqueRunToken` as a blind reviewer, assert no element with class containing `optimizer-marker` or `optimizer-history` is rendered.
- **Label picker (§8.10).** Label values are vocabulary, not metadata. They appear in evaluator views without leaking version info. Test: snapshot the picker DOM, assert no `data-version-*` / `data-run-*` attributes.
- **Dock layout (§8.11).** Evaluator-session registry is a strict subset (`EVAL_GRID`, `ANNOTATIONS`). Test: instantiate the dock with `role: "evaluator"`, assert that calling `.addPanel({ id: "EDITOR" })` throws or no-ops.
- **Onboarding tour (§8.12).** Tour does not run on `/eval/*` routes; it dismisses silently if the only role for the current user is evaluator. Test: sign in as evaluator-only, navigate to `/eval`, assert no `[data-tour]` element renders.

---

### Open Review — non-blind reviewer surface

M26 introduces a second reviewer persona: the **open reviewer** (`role === "evaluator"`, `blindMode === false`). PMs, legal counsel, and domain experts who need full context to give useful feedback. They are explicitly out of scope for the 13 blind-eval rules above — they are supposed to see the prompt and the model.

**Routing.**
- Invite-accept for a project invite with `blindMode === false` lands on `/review/:projectId` (see [Section 4 — Reviewer dashboard](#)).
- Blind reviewers continue to land on `/eval`.
- The reviewer dashboard query (`reviewerHome.getProjectReview`) returns `null` for non-collaborators and blind reviewers, which the route renders as a 404/redirect.

**Reviewer dashboard (`/review/:projectId`).** Sections in order: project header, latest-draft preview (read-only Tiptap render of messages), "Examples waiting for your review" (recent runs missing this reviewer's annotations, reactive), "Drafts ready to review" (new non-draft versions the reviewer hasn't annotated). Jargon constraints — none of "v1/v2/vN", "DRAFT/ACTIVE/ARCHIVED" pills, model strings, or temperature values render in the DOM. Message role labels are reframed as "Instructions / Example question / Sample answer".

**Read-only `VersionEditor` mode.** The same route serves the open reviewer when they click "View full draft" from the dashboard. `MessageComposer` is `readOnly={true}` with the annotation overlay forced on. Right pane (variables, runs, optimization, meta context) is hidden. Top bar shows "{project} · Latest draft" instead of "Version N" + status pill. Run / Save / Fork / Optimize buttons are hidden. The single-tab "Prompt" view is the only surface visible.

**Feedback acknowledgment loop.** After an open reviewer submits an annotation, a toast confirms: "Feedback submitted. The author will be notified, and you'll get an email when an improved draft is ready." When an editor's `versions.update` auto-promotes a draft to "current", the scheduler hands off to `reviewerNotificationActions.sendNewDraftEmails`, which emails every `blindMode: false` collaborator on the project (excluding the author). Rate-limited to one email per (reviewer, project) per 24h via the `reviewerNotifications` ledger. Email subject: `New draft of {projectName} ready for your review`; body includes the optimizer's `changesSummary` if the version was optimizer-generated, otherwise "Manual edit"; CTA links to `/review/:projectId`.

**Authorization carryover.** Editor-only mutations still reject `role === "evaluator"` regardless of `blindMode`. The open reviewer can read versions and runs but cannot edit, run, fork, or trigger optimization — the role gate is the authoritative authz line, `blindMode` only relaxes reads.

---

## 11. Accessibility

- **Target**: WCAG 2.1 AA.
- **Keyboard navigation**: every primary action (annotate, run, optimize, compare, accept, rollback, invite) has a keyboard path and a shortcut listed in [Section 13](#13-keyboard-shortcuts).
- **Focus ring**: visible on all interactive elements. Matches the brand accent color. Respects `prefers-reduced-motion`.
- **Screen reader labels**: every icon-only control (model picker, status pill, blind label badge, delete button, drag handle) has an `aria-label`.
- **Color contrast**: ≥ 4.5:1 on all text against its background. ≥ 3:1 on large text. No text on top of images without a scrim.
- **Diff view non-color cues**: every added/removed line has a leading icon (`+`, `-`, `~`) in addition to the color. Moves have a distinct icon. Screen readers announce "added", "removed", "moved".
- **Streaming cursor**: `▋` blink pauses when `prefers-reduced-motion` is set.
- **Modals**: trap focus on open, restore focus on close, close with `Esc`, click-outside-to-close for non-destructive modals and click-outside-is-ignored for confirmation modals.
- **Tiptap annotation flow is keyboard-operable**: select text with `shift+arrow`, trigger the comment button with `C`, submit with `⌘Enter`, cancel with `Esc`. Every annotation is reachable by tab-navigating through the highlights.
- **Live regions for streaming**: `<StreamingOutputPanel>` is `aria-live="polite"` so screen readers announce new content without interrupting. The status pill updates use `aria-live="polite"` too.
- **Blind label badges** announce as "Output A" etc.
- **Forms** use `<label>` for every input. Error messages are associated via `aria-describedby`.

---

## 12. Microcopy guide

### Tone

- **Concise, technical, no hype.** "Run prompt" beats "✨ Generate magic ✨". "Request optimization" beats "Let AI improve your prompt!".
- **No apologies for normal behavior.** "Saving..." not "Please wait while we save your changes...".
- **Second-person voice where it's natural**, third-person where it's awkward. "Your API key is encrypted" not "The API key is encrypted". But: "Couldn't reach Convex" not "We couldn't reach Convex" (the former is shorter and implies the system).

### Error messages

- **Lead with what happened, not an apology.** "Couldn't reach OpenRouter." not "Oops! Something went wrong.".
- **Give the next action.** "Couldn't reach OpenRouter. Check your API key." not "Couldn't reach OpenRouter.".
- **Name the resource specifically.** "Couldn't load runs." not "Couldn't load data.".
- **Ban "Something went wrong" entirely.** Every error message must name the subsystem, the resource, or both.

### Button labels

- **Verb + noun, present tense, imperative.** "Run prompt", "Request optimization", "Accept changes", "Delete version", "Invite collaborator".
- **Destructive buttons are a distinct color (red)** with a verb that names the destruction explicitly: "Delete", "Remove", "Roll back", "Cancel run".
- **"Submit" is banned.** Prefer the specific verb: "Save", "Send", "Create", "Accept".

### Confirmation dialogs

- **State the irreversible action explicitly** in the body, not the title.
- "**Delete version 3?** Associated runs and feedback will also be deleted. This can't be undone."
- "**Remove Alice?** They'll lose access to this project immediately."
- "**Roll back to v2?** This creates a new version at the head of the timeline with the content of v2."

### Empty states

- **Describe the next action, not the current emptiness.** "Create your first test case to start running prompts." not "No test cases found.".
- **One sentence.** Anything longer hides the CTA.
- **The CTA verb matches the next action.** "New test case", not "Get started".

### Status text

- **Present tense for in-progress, past for completed.** "Running..." / "Completed 12s ago".
- **Relative time for recent, absolute for old.** "2m ago", "12h ago" for under 48h; "Apr 8" for older.
- **Token counts abbreviated**: "1.2k tokens" not "1,247 tokens" unless precision matters (billing / auditing).

### Onboarding callouts

- **Explain the next step, not the feature.** "Click Run to see your prompt execute" not "Blind Bench runs your prompt with streaming LLM output across multiple outputs simultaneously to enable comparison".
- **One callout at a time.** Never more than one visible.
- **Always dismissible.**

---

## 13. Keyboard shortcuts

| Shortcut | Action | Available on |
|---|---|---|
| `⌘K` / `Ctrl+K` | Open command palette | Everywhere |
| `⌘Enter` | Run prompt | Version editor |
| `⌘S` | Save draft | Version editor |
| `⌘R` | Request optimization | Version editor, feedback viewer |
| `J` / `K` | Next / prev output | Run viewer, eval view, compare |
| `C` | Add comment on selection | Any annotatable editor |
| `⌘Enter` | Submit comment | Comment popover |
| `Esc` | Close modal / popover / dismiss callout | Everywhere |
| `V` | Toggle version comparison | Run detail |
| `/` | Focus search in command palette | Command palette |
| `G then P` | Go to projects | Org shell |
| `G then R` | Go to runs | Project shell |
| `G then T` | Go to test cases | Project shell |
| `G then V` | Go to versions | Project shell |
| `↑` / `↓` | Navigate lists | Any list view |
| `Enter` | Open focused list item | Any list view |
| `N` | New (project / test case / version — context sensitive) | List views |
| `?` | Show shortcut cheat sheet | Everywhere |

Shortcut cheat sheet is a modal triggered by `?` listing the shortcuts available on the current screen.

---

## 14. Responsive model

### Breakpoints

- **Desktop (≥1280px)**: full experience. Primary target.
- **Tablet (768–1279px)**: not a primary target; editor routes render but may be narrow. Compare screen collapses from a grid to a horizontal scroll. No special optimization — the goal is "works", not "great".
- **Mobile (<768px)**: only `/eval` and `/eval/:opaqueRunToken` and `/profile` are supported. Every other route shows a "desktop required" screen with a single sentence: "Blind Bench is a desktop tool. Open this on a computer."

### Why mobile eval is supported

Evaluators are often mobile-first users responding to review requests from email. The eval inbox needs to work on a phone. The editing experience doesn't — authoring prompts on a 375px screen would hurt more than it would help.

### Mobile evaluator view specifics

- Three output columns collapse to a single vertical stack. Scroll from output A → B → C.
- The comment popover becomes a full-screen sheet rather than an anchored popover (selection positioning on mobile is unreliable).
- `J/K` shortcuts become swipe-left / swipe-right on mobile.
- The "Submit feedback" button is a sticky bottom bar.

---

## 15. Onboarding

### Progressive disclosure

- **Advanced run settings** (seed, top-p, stop sequences) are hidden behind a "More" toggle on first run. Once expanded, they stay expanded for that user across sessions (preference stored in `users.preferences`).
- **Meta context** is not required, but the first optimization attempt on a project with no meta context shows an inline notice: "Optimize without meta context? Meta context helps ground the rewrite in your project's intent. Set it up first, or continue."
- **Temperature default is 0.7.** Users can always change it; we don't ask on first run.

### Sample project seed

On the org's first project creation modal, a checkbox: "Start with a sample project". If checked, the project is pre-populated with:
- A variable: `text`, description "The text to translate".
- A test case: "Casual paragraph" with a realistic English sample.
- v1 system message: "You are a translator. Render English text into natural, idiomatic French suitable for native speakers."
- v1 user template: "Translate: {{text}}"
- 3 meta context questions pre-answered ("What domain?" / "What tone?" / "Who's the end user?").

This gets the user to an interesting "Run prompt" click within 10 seconds of creating the project.

### Inline callouts (not a tour, not a modal)

Three one-time callouts shown in order, dismissible, never shown again per user:

1. **First version editor load**: callout pointing at the Run button. "Click Run to execute your prompt against the selected test case."
2. **First completed run**: callout pointing at the output text. "Select any text and press `C` to leave a comment."
3. **First annotation saved**: callout pointing at the Request Optimization button. "Optimize to turn your feedback into a new version."

### First-run onboarding tour (M27)

For users who would benefit from a guided walkthrough — particularly first-time prompt engineers and reviewers landing in an unfamiliar product — `<OnboardingTour>` (see [§8.12](#812-first-run-onboarding-tour)) opens automatically on first sign-in. It is dismissible from the first frame and resumable from `Settings → Onboarding`. Inline callouts above remain as the lower-friction fallback for users who skip the tour.

---

## Related
- [[Blind Bench - Architecture]]
- [[Blind Bench - Optimizer Meta-Prompt]]
- [[Blind Bench - Glossary]]
- [[Blind Bench - Build Plan]]
- [[MOC - Blind Bench]]
