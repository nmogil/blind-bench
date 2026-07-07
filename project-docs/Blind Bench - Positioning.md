# Blind Bench — Positioning

Working doc. Captures the pivot away from developer-tool framing toward
non-technical buyers. Expand as customer conversations sharpen the thesis.

Last updated: 2026-07-07

---

## 2026-07-07 update — persona generalization (supersedes parts of this doc)

Approved by Noah 2026-07-07. Source of truth:
[[Blind Bench - Agent Trace Strategy]]. The doc below is kept intact as
history; where it conflicts with this addendum, this addendum wins.

The unit of AI work moved from *a prompt's output* to *an agent's
trajectory*. The persona moves with it.

**The persona generalizes** from "non-technical reviewer" to **domain expert
reviewer** — the person whose judgment matters, reviewing without bias,
without living in a dashboard. It's the GC for legal tone, the CX lead for a
support agent, the senior engineer for a coding-agent trace. The through-line
was never "non-technical." It was "the right reviewer, blind, with no
friction."

**"Developers are the anti-persona" is retired.** For agent traces, the
qualified reviewer of a Claude Code trajectory is usually a senior engineer or
domain expert. Technical reviewers are now first-class *reviewers*, not just
buyer-influencers.

**What survives unchanged:** blind-by-default; zero-friction, shareable-link
review with no account required; plain-language reviewer surfaces; feedback
that flows somewhere (into the prompt, into training data), never into a dead
dashboard.

**What stays true:** we are still NOT a tracing platform. BlindBench is the
**judgment layer** that tracing platforms, harnesses, and sandboxes feed into.
The blind-eval discipline — enforced at the Convex function boundary, opaque
tokens, no provenance in the DOM — is the asset none of them have.

---

## One-liner

**Google Docs for AI evaluation.**

The place non-technical reviewers — PMs, legal, marketing, compliance, CX,
content leads — rate and comment on AI outputs so their team can ship
prompts the business actually trusts.

## The pivot

Earlier drafts framed Blind Bench as a peer to Braintrust, Langfuse, and
PromptLayer: a platform for prompt engineers. That framing loses.

- Those tools are built for developers who live in an IDE, read traces, and
  think in spans.
- The people whose judgment actually matters for prompt quality — the
  domain experts, the brand owners, the lawyers — don't live there.
- Competing on developer ergonomics against mature incumbents is a bad
  bet. The non-dev reviewer surface is largely unoccupied.

So Blind Bench is not "a better tracing platform." It's the **reviewer
surface** that plugs into whatever tracing platform a team already runs.

## Who we're building for

Primary: **non-technical reviewers and the leaders who depend on them.**

> [2026-07-07: generalized to **domain expert reviewer** — see the addendum at
> the top. The persona is the right reviewer for the artifact, not
> specifically a non-technical one.]

- VP Marketing, Head of Content — signing off on brand voice in AI output
- General Counsel, compliance — reviewing AI responses for risk
- Head of CX, support leads — grading agent replies against policy
- PMs — the person who actually knows what "good" looks like for the feature

Secondary: **the developer or prompt engineer who ships the prompts** —
they're the buyer-influencer, not the user. They want fast, honest
feedback from the people above without scheduling a meeting.

Explicit anti-persona: prompt engineers running eval suites against LLM
judges. That's the tracing platforms' job. Don't rebuild it.

> [2026-07-07: "developers are the anti-persona" is **retired** — see the
> addendum at the top. For agent traces, senior technical reviewers are often
> the correct reviewers. The anti-persona is anyone reviewing *biased* or
> living *in a dashboard*, not developers as such.]

## Why this matters (the pain)

Shipping LLM features today forces a broken loop:

1. Feedback is hard to collect. Experts are busy. Internal reviews are
   political. Customer signals don't close the loop.
2. When feedback *does* arrive, it's biased — reviewers see model names,
   version numbers, or who wrote the prompt, and score accordingly.
3. Applying the feedback is manual. Comments live in Slack, Docs, emails.
   Nothing is linked to the prompt that produced the output.

Blind Bench removes friction on both halves:

- **Collection:** one-link invite, no account required, labels shuffled so
  reviewers can't game.
- **Application:** annotations flow into the optimizer that rewrites the
  prompt, citing every comment.

Blind evaluation is the feature that makes the feedback *honest*. It is
not the headline product claim.

## What we are, what we aren't

**We are:**
- The reviewer-facing surface where non-devs rate and comment.
- The feedback → better-prompt loop, closed.
- An opinion that human judgment is the source of truth when "good" is
  subjective (voice, brand, risk, tone).

**We aren't:**
- A tracing platform. We plug into Langfuse / PostHog / PromptLayer.
- An LLM-as-judge eval harness. That's a commodity.
- A developer tool. Devs are the buyer-influencer, not the reviewer.

## Vocabulary (reviewer-facing)

Non-dev reviewers never see jargon. The purge applied to reviewer UI
surfaces (CycleEvalView, CycleShareableEvalView, EvalInbox,
AnnotatedEditor, RatingButtons):

| Old (dev-speak)          | New (plain English)                |
| ------------------------ | ---------------------------------- |
| evaluation / eval        | review                             |
| cycle                    | review                             |
| output                   | response                           |
| preferences              | ratings                            |
| annotate / annotation    | comment                            |
| model output             | response                           |
| Submit feedback          | Submit review                      |
| Submit preferences       | Submit ratings                     |
| Pending evaluations      | Reviews waiting for you            |
| No pending evaluations   | You're all caught up               |
| Back to inbox            | Back to your reviews               |

Preserved: the *adjective* "blind" (as in "blind review") — it earns its
keep as the honesty mechanic. URL slugs (`/eval`, `/eval/cycle/...`)
unchanged for now.

Author-facing UI (VersionEditor, RunConfigurator, CycleCreator) still uses
technical terms — those are seen by the engineer-buyer, not reviewers.
Revisit if we ever expose prompt authoring to non-devs.

## Positioning vs. the tracing platforms

| Axis                   | Braintrust / Langfuse / PromptLayer | Blind Bench                      |
| ---------------------- | ----------------------------------- | -------------------------------- |
| Primary user           | Developer / prompt engineer         | Non-technical domain reviewer    |
| Surface                | IDE, dashboard, trace viewer        | Shareable link, inbox, comments  |
| What "eval" means      | LLM-as-judge, metrics, regressions  | Human ratings + inline comments  |
| Where feedback goes    | Dashboard for devs to inspect       | Straight into prompt rewrite     |
| Account required?      | Yes                                 | No (shareable-link reviewer)     |
| Moat                   | Trace ingest breadth                | Human-in-the-loop UX + optimizer |

We are complementary, not competitive. The natural integration story:
traces arrive in Langfuse / PostHog, the team forwards selected outputs
into Blind Bench for human sign-off, then the optimizer closes the loop
back to the prompt version.

## Risks

- **Adoption friction is the main killer.** Reviewers only open the link
  if the ask is small and the UI reads as non-technical from the first
  screen. Every piece of dev-speak on a reviewer surface is a churn risk.
- **Buyer confusion.** If a dev lands on the marketing page expecting a
  tracing tool, they bounce. Landing copy has to name the reviewer
  persona in the first viewport.
- **Moat depth.** Braintrust can ship a reviewer surface if they decide
  to. Our edge is opinionation (blind by default, optimizer-first loop),
  not feature breadth.
- **Scope creep.** Every request to "also support LLM judges" or "also
  replay traces" drifts us back into the tracing-platform fight we chose
  to avoid.

## What we still need to validate

Customer conversations planned — target 5 non-dev leaders (VP Marketing,
GC, Head of CX, Head of Content, senior PM shipping an LLM feature).
Core questions:

1. How do you give feedback on AI output today? Where does it live?
2. When feedback gets applied, how do you know?
3. Who on your team owns "is this response good"? Is it you?
4. Would you click a link from a teammate to rate three responses blind?
5. What would make you *not* click it?

Script and findings live separately. Update this doc as answers land.

## Near-term implications

- **Landing page:** hero rewrite around the named reviewer persona, not
  around blind-eval methodology. Lead with the feedback loop.
- **Onboarding:** empty states and first-run flow should explain the
  reviewer role, not prompt versioning.
- **Roadmap filter:** for every open issue (M18–M23 and beyond), ask
  "does this help human evaluation, or is it a Braintrust rebuild?"
  De-prioritize the latter.
- **Integrations:** trace import from Langfuse / PostHog / PromptLayer is
  a *complement*, positioned as "bring your traces in for human
  sign-off," not "replace your tracing platform."
