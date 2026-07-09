---
title: "MOC - Blind Bench"
created: 2026-04-11
modified: 2026-07-08
type: moc
status: planning
domain: ideas
tags:
  - moc
  - blind-bench
---

# MOC - Blind Bench

> Navigation hub for Blind Bench — the blind human-review layer for AI agents.

**Status**: Agent-first strategy active (2026-07-08). M30/Pennie and M31 Trajectory Spine are tracked in GH issues; older prompt-engineering docs remain historical unless superseded by the positioning one-pager or agent trace strategy.

---

## Start here
- [[Blind Bench - Architecture]] — system design, data model, Convex functions, auth model, design decisions
- [[Blind Bench - Glossary]] — locked vocabulary for the product (version, run, output, test case, blind label, meta context, etc.)

## Product & Design
- [[Blind Bench - UX Spec]] — design principles, sitemap, screen catalog, component inventory, user flows, states, blind-eval security rules, accessibility, microcopy, keyboard shortcuts
- [[Blind Bench - Architecture#Authorization Model]] — role × action matrix that the UX spec enforces at the browser-surface level
- [[Blind Bench - Architecture#Data Flow: Prompt Optimization Cycle]] — the loop the product is built around

## Strategy & positioning
- [[Blind Bench - Positioning One-Pager]] — current decision of record: agent-first framing, "blind human-review layer for AI agents"
- [[Blind Bench - Agent Trace Strategy]] — M31 strategy, sequencing, risks, and the 2026-07-08 post-deployment critique/guardrails
- [[Blind Bench - AI Quality Bench Spec]] — M30/Pennie product loop: Cloudflare Gateway logs → evals → training → scorecard
- [Canonical demo loop](../docs/canonical-demo-loop.md) — the one path marketing, onboarding, and demos should lead with

## Implementation
- [[Blind Bench - Build Plan]] — M0 through M7 milestones with deliverables, acceptance criteria, testable demos, dependency graph
- [[Blind Bench - Optimizer Meta-Prompt]] — scaffolding (input/output schema, constraints, validation, versioning, eval) around the core meta-prompt the owner drafts

## Background
- [[Blind Bench - Architecture#Overview]] — tech stack table and core workflow
- [[Blind Bench - Architecture#v1 Scope & Deferred]] — what ships in v1 and what's explicitly pushed

---

## Parent
- [[MOC - Ideas Hub]]

## Related MOCs
- [[MOC - AI & Agents]]
- [[MOC - Web Development]]
