---
title: "Blind Bench - Glossary"
created: 2026-04-11
modified: 2026-04-11
type: reference
status: planning
tags:
  - blind-bench
  - glossary
  - reference
---

# Blind Bench — Glossary

> Part of [[MOC - Blind Bench]]

Locked vocabulary for the product. Every term used in the architecture, UX spec, build plan, and optimizer doc should resolve here. If you catch yourself using an ambiguous word ("result", "comment", "session"), prefer the term in this glossary.

Terms are listed alphabetically. Each is an `h3` heading so cross-references like `[[#Output]]` resolve within the doc.

---

### Annotation

A highlight + comment on a specific range of text, created via the Tiptap editor. The canonical feedback primitive. Stored as `{ from, to, highlightedText, comment, label }` on either an [[#Output]] (output feedback) or a [[#Version]] (prompt feedback). The `label` field (M27.4) is one of `suggestion / issue / praise / question / nitpick / thought` — see [[#Annotation label]]. See [[Blind Bench - Architecture#Data Model (Convex Schema)]].

### Annotation label

The conventional-comments-style category attached to every [[#Annotation]]. Six values: `suggestion`, `issue`, `praise`, `question`, `nitpick`, `thought`. Each maps to a tone (info / warning / success / muted) used for the tonal pill background in `<LabelPicker>`. The label is structured signal for the [[#Optimizer meta-prompt]] — different labels carry different weight in the rewrite. Introduced in M27.4. Default value on new annotations is `thought`. See [[Blind Bench - UX Spec#8.10 Conventional label picker]].

### Annotation toolbar

The floating, draggable comment surface for the eval grid (M27.3). Replaces the anchored popover on the eval-grid surface only — the prompt editor continues to use its inline annotation popover. Falls back to a bottom-sheet modal on touch / narrow viewports. Position is session-scoped (not persisted). See [[Blind Bench - UX Spec#8.8 Annotation toolbar (floating, draggable)]].

### Attachment

An image file stored in Convex file storage and wired into a run for vision models. Two flavors: **prompt attachments** live on a [[#Version]] and are included in every run of that version; **test-case attachments** live on a [[#Test case]] and are included only when that test case runs. Never stored as URLs — always resolved via `ctx.storage.getUrl()` at read time. See [[Blind Bench - Architecture#File Storage & DB Size]].

### Blind Mode

A per-invite, per-collaborator boolean flag (`projectCollaborators.blindMode`, `invitations.blindMode`) that gates whether a [[#Reviewer]] sees the prompt or only blinded [[#Output]]s. Introduced in M26. Only meaningful when `role === "evaluator"`; ignored for [[#Owner (role)]] / [[#Editor (role)]] / org roles.

- **Blind reviewer** (`blindMode === true` or absent): today's evaluator behavior. Sees only A/B/C-labeled outputs and leaves [[#Output feedback]]. Cannot see the [[#Version]], the model, or who else has reviewed. Routed to `/eval`.
- **Open reviewer** (`blindMode === false`): can read the prompt and outputs in full, sees author attribution on peer comments, and lands on `/review/:projectId`. Designed for non-technical stakeholders (PM, legal, domain expert) who need context to give useful feedback.

**Rule 7 invariant** (from [[Blind Bench - UX Spec#10 Blind eval security rules]]): Blind Mode cannot retroactively re-blind information a reviewer has already seen. Switching a reviewer from blind → open is fine; the reverse is not, and the schema does not support changing the flag on a live row in v1 — it's set at invite time and propagates to `projectCollaborators` on accept.

**Code literal:** the role string remains `"evaluator"` in `projectCollaborators.role` regardless of Blind Mode. The user-facing label is "Reviewer" (or "Blind reviewer") via `RoleBadge`. A future milestone may rename the literal to `"reviewer"`.

Gating helper: `isBlindReviewer(ctx, projectId)` in `convex/lib/auth.ts`. Every blind-eval security filter rides on it instead of `role === "evaluator"`.

### Blind label

The neutral identifier (`A`, `B`, `C`, ...) shown to an [[#Evaluator (role)]] in place of any version or run metadata. The `<BlindLabelBadge>` component in [[Blind Bench - UX Spec#5 Component inventory]] renders this. Blind labels are the only user-visible identifier on an [[#Output]] in the evaluator view.

### BYOK

"Bring Your Own Key" — the v1 cost model: each [[#Organization]] supplies its own [[#OpenRouter]] API key, which Blind Bench encrypts at rest (AES-GCM) and uses only inside Convex actions. No platform key, no billing infrastructure, no dollar budgets in v1 — just a [[#Concurrent run cap]] guardrail. See [[Blind Bench - Architecture#BYOK Key Handling]].

### Collaborator

A user who has been invited to a [[#Project]] and holds a role of [[#Owner (role)]], [[#Editor (role)]], or [[#Evaluator (role)]]. Collaborators are project-scoped; [[#Organization]] membership is a separate concept.

### Concurrent run cap

A soft cap on in-flight runs per project (default 10), enforced in `runs.execute`. Exists to prevent a runaway optimizer loop from firing thousands of streaming calls against the [[#Organization]]'s BYOK key. The only cost guardrail in v1.

### Dock

The resizable, tabbable, rearrangeable multi-panel workspace shipped in M27.7. Powered by `dockview-react`. Hosts five panel types: `EDITOR`, `EVAL_GRID`, `ANNOTATIONS`, `OPTIMIZER_HISTORY`, `RUN_LOGS`. Per-route default layouts are persisted per-user to localStorage. Evaluator sessions use a strict subset of panels for blind-eval safety. See [[Blind Bench - UX Spec#8.11 Dock layout (multi-panel workspace)]] and [[Blind Bench - Architecture#Frontend UI Layers (M27)]].

### Draft

A [[#Version]] status. A draft version can be edited and deleted. Once set to `active` it's immutable except for status transitions. Runs and feedback only make sense against non-draft versions in v1. See [[Blind Bench - Architecture#Data Model (Convex Schema)]].

### Editor (role)

A [[#Collaborator]] who can view everything about a [[#Project]], create and edit versions, manage test cases and variables, execute runs, leave both output and prompt feedback, and request and accept optimizations. Cannot invite other collaborators or delete the project. See [[Blind Bench - Architecture#Authorization Model]].

### Evaluator (role)

A [[#Collaborator]] who can only see blinded [[#Output]]s (labeled A/B/C with no version information) and leave [[#Output feedback]]. Cannot see [[#Version]]s, cannot see which version produced which output, cannot execute runs, cannot request optimization. All blind-eval enforcement lives at the Convex function boundary — see [[Blind Bench - Architecture#Authorization Model]] and the 13 browser-surface rules in [[Blind Bench - UX Spec#10 Blind eval security rules]].

### Fan-out

The pattern of executing a single [[#Run]] as three parallel OpenRouter calls, producing three [[#Output]]s with blind labels `A`/`B`/`C`. Configured via `runCount` on the `runs.execute` mutation. The primitive behind A/B/C blind evaluation. See [[Blind Bench - Architecture#How a run actually executes in Convex]].

### Meta context

An array of `{question, answer}` pairs the [[#Owner (role)]] fills in once per [[#Project]] answering things like "What domain?", "What tone?", "Who's the end user?". Feeds the [[#Optimizer meta-prompt]] alongside feedback during optimization. Stored on `projects.metaContext`. See [[Blind Bench - Architecture#Data Model (Convex Schema)]].

### OpenRouter

The LLM gateway Blind Bench uses for every model call. Each [[#Organization]] supplies its own key ([[#BYOK]]), encrypted at rest. Only touched inside Convex actions — see [[Blind Bench - Architecture#BYOK Key Handling]].

### Optimization request

A row in the `optimizationRequests` table representing one iteration of the optimize loop: feedback in, new prompt out, human review, accept/edit/reject. Each request is bound to a single [[#Version]]. If accepted, it spawns a new `promptVersions` row linked back via `resultingVersionId`. See [[Blind Bench - Architecture#How optimization executes]].

### Optimizer marker

The inline sparkle icon rendered in the Tiptap editor gutter on each line range the optimizer changed in the current [[#Version]]. Click reveals the per-change `rationale` from the optimizer's structured output. Introduced in M27.5; not visible on the evaluator (`/eval`) surface. See [[Blind Bench - UX Spec#8.9 Optimizer markers (inline sparkles)]].

### Optimizer meta-prompt

The fixed system prompt that takes feedback + current prompt + meta context and returns a proposed new prompt. The core IP of the product. Scaffolding is spec'd in [[Blind Bench - Optimizer Meta-Prompt]]; the actual prompt text is a TODO the owner drafts.

### Organization

The top-level tenant in Blind Bench. Owns [[#Project]]s, members, and the [[#OpenRouter]] BYOK key. Users can belong to multiple orgs; roles at the org level (`owner`, `admin`, `member`) are separate from roles at the project level.

### Output

The text produced by one OpenRouter call during a [[#Run]]. A run has `runCount` outputs, each with a [[#Blind label]] and `outputContent`. Accumulated via chunk-append during streaming. See [[Blind Bench - Architecture#How a run actually executes in Convex]].

### Output feedback

An [[#Annotation]] on a specific range of an [[#Output]]. The primary signal the [[#Optimizer meta-prompt]] uses during an [[#Optimization request]]. Evaluators can leave output feedback without seeing which version produced the output.

### Owner (role)

A [[#Collaborator]] who can do everything an [[#Editor (role)]] can plus: invite collaborators, change roles, set the project's [[#Meta context]], and delete the project. The creator of a project is automatically the Owner.

### Parent version

The predecessor of a [[#Version]] in the linear version sequence. Stored on `promptVersions.parentVersionId`. Every non-initial version has a parent. Distinct from [[#Source version]] which tracks rollback origin.

### Project

A unit of prompt iteration owned by an [[#Organization]]. Contains versions, variables, test cases, meta context, collaborators, runs, feedback, and optimization requests. One prompt per project (conceptually) — multiple versions of the same prompt, not multiple independent prompts.

### Project variable

A named placeholder (e.g., `{{customer_name}}`) that can appear in a [[#Version]]'s template. Variables are project-scoped, not version-scoped — they're shared across every version of a project, which is what makes cross-version comparison possible. See [[Blind Bench - Architecture#Template Syntax]].

### Prompt feedback

An [[#Annotation]] on a specific range of a [[#Version]]'s system message or user template. Distinct from [[#Output feedback]]. Feeds the [[#Optimizer meta-prompt]] alongside output feedback. Evaluators cannot leave prompt feedback (they don't see the prompt).

### Reviewer

User-facing label for a [[#Collaborator]] with `role === "evaluator"`. Two flavors, distinguished by [[#Blind Mode]]:

- **Reviewer (open)** — `blindMode === false`. Sees the prompt, model, and peer comments. Primary persona: non-technical stakeholder (PM, legal, domain expert). Lands on `/review/:projectId`. Can leave [[#Prompt feedback]] and [[#Output feedback]] but cannot edit, run, or trigger optimization.
- **Reviewer (blind)** — `blindMode === true` or absent. Today's `Evaluator (role)` behavior. Sees only A/B/C-labeled outputs in a session. Lands on `/eval`.

The `evaluator` literal is retained in code (`projectCollaborators.role`, `cyclePreferences.source`) until a later rename milestone — see [[#Blind Mode]] for the code-literal note.

### Rollback

Creating a new [[#Version]] at the head of the sequence by copying the content of an earlier version. The new version has `parentVersionId` pointing to the current head and `sourceVersionId` pointing to the copied version. Preserves both sequence and rollback origin without branching. See [[Blind Bench - Architecture#Key Design Decisions]].

### Run

One execution of a specific [[#Version]] against a specific [[#Test case]] at a specific model configuration (model, temperature, max tokens). Produces `runCount` [[#Output]]s via [[#Fan-out]]. Runs are the unit of comparison: running the same test case against v1/v2/v3 is the primitive for "is v2 actually better than v1?".

### Source version

For a [[#Rollback]], the version that was copied. Stored on `promptVersions.sourceVersionId` (nullable). E.g., if v4 is a rollback to v2's content, v4 has `parentVersionId = v3` and `sourceVersionId = v2`. Distinct from [[#Parent version]].

### Streaming chunk append

The pattern Convex uses to deliver LLM output live to the client. The action receives chunks from OpenRouter and calls the internal mutation `runs.appendOutputChunk` on each chunk; the client is subscribed to `runs.get(runId)` and reactively sees `outputContent` grow. Replaces HTTP streaming. See [[Blind Bench - Architecture#How a run actually executes in Convex]].

### System message

The system-role portion of a prompt in a [[#Version]]. Optional. Edited in the Tiptap editor. Can receive [[#Prompt feedback]] annotations separately from the user template.

### Test case

A named, reusable bundle of `{variableValues, attachmentIds}` for a [[#Project]]. Project-scoped, shared across all versions. Running the same test case against multiple versions is the primitive for cross-version comparison. See [[Blind Bench - Architecture#Data Model (Convex Schema)]].

### User template

The user-role portion of a prompt in a [[#Version]], containing Mustache-style `{{variable}}` placeholders. Required. Template syntax is a deliberate minimal subset — no logic, no conditionals, no partials. See [[Blind Bench - Architecture#Template Syntax]].

### Version

An immutable (once promoted out of [[#Draft]]) snapshot of a system message + user template for a [[#Project]]. Versions are linearly sequenced via [[#Parent version]]. Status is `draft`, `active`, or `archived`. Versions are the unit of optimization — you optimize a specific version and the result spawns a new version.

---

## Related
- [[Blind Bench - Architecture]]
- [[Blind Bench - UX Spec]]
- [[Blind Bench - Optimizer Meta-Prompt]]
- [[Blind Bench - Build Plan]]
- [[MOC - Blind Bench]]
