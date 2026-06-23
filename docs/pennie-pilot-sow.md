# Pennie × Blind Bench AI Quality Bench pilot

## One-page pilot proposal

**Objective:** give Pennie an operational AI quality loop for the AI systems Mogil Ventures/Blind Bench already helps run: initial focus on Eavesly and Migo, with a path to Jeeves / Pennie Systems AI agent harnesses.

**Positioning:** Pennie is not buying abstract eval infrastructure. Pennie is buying a managed AI quality bench: visibility, human review, regression tests, model/prompt comparison, and a path to fine-tuning-ready data.

## Initial scope

Phase 1 covers a scoped set of synthetic/redacted Eavesly and Migo workflows:

- Eavesly: QA/disposition/manager-insight style cases, escalation correctness, false-positive/false-negative review, read-only safety, groundedness.
- Migo: summary/chat completion cases, required field capture, customer-facing tone, structured behavior, no overclaiming.
- Runner: local repeatable command emits JSON + Markdown scorecards.
- Review: manual/managed review loop first; productized reviewer console follows after the pilot proves pull.

## Pilot deliverables

1. **AI Quality Scorecard**
   - apps/modules evaluated
   - models/prompts compared
   - reviewed sample count
   - pass/fail and preference results
   - hard-fail privacy/safety findings separated from soft quality scores
   - cost/latency/token comparison where available
   - top failure modes
   - recommended prompt/model changes
   - promoted regression cases
   - fine-tuning readiness notes

2. **Pennie-scoped regression seed set**
   - synthetic/redacted cases only unless production trace use is explicitly approved
   - stable case IDs
   - expected behavior and scorer assignments
   - local runner compatibility

3. **Data-boundary report**
   - what data was used
   - what was redacted
   - what can/cannot be exported
   - whether any case is eligible for training/fine-tuning export

4. **Payment handoff**
   - first pilot can be invoiced/manual
   - Polar self-serve packages are tracked separately and should not block the first Pennie pilot

## Success criteria

The pilot is successful if Pennie can answer:

- Which AI workflows were evaluated?
- Which prompt/model variant is safer or better?
- Did any candidate introduce privacy/safety hard-fails?
- What are the top failure modes?
- Which cases should become regression tests?
- What human-reviewed data is accumulating toward future fine-tuning?
- What should Pennie change next?

## IP and data ownership

| Asset | Owner | Rule |
| --- | --- | --- |
| Pennie production traces | Pennie | Pennie-scoped only; not reused for generic Blind Bench assets. |
| Pennie reviewed cases/labels | Pennie | Stored/exported only within the Pennie workspace or approved handoff. |
| Pennie scorecards | Pennie + Blind Bench service artifact | Customer-facing; no raw PII/transcripts by default. |
| Generic schemas/runners/scorers/adapters | Blind Bench / Mogil Ventures | Reusable product infrastructure. |
| Synthetic examples | Blind Bench / Mogil Ventures | May be reused if they contain no Pennie/customer confidential facts. |
| Fine-tuning exports | Pennie-scoped | Only reviewed/approved examples; no shared-model use without written approval. |

## Data-boundary rules

- Pennie customer data cannot train or seed generic Blind Bench assets.
- Production traces are Pennie-scoped by default.
- Use synthetic cases until the SOW explicitly allows redacted production trace use.
- No real call transcripts, account numbers, phone numbers, emails, SSNs, payment cards, or secrets in the repo.
- Reviewed outputs promoted to regression must freeze the input/output/metadata snapshot.
- Training/fine-tuning export requires explicit approval and data classification.

## Pricing / commercial shape

Recommended first package: **Pennie AI Quality + Regression pilot**.

Commercial default:

- Monthly managed pilot fee or fixed 30-day pilot fee.
- Manual invoice/payment acceptable for the first Pennie pilot.
- Polar integration should support repeatable self-serve packages later but is not a blocker for first value delivery.

## Related-party / vendor approval note

Blind Bench is still owned by Mogil Ventures. Any Pennie procurement/vendor approval should state:

- the work is Pennie-scoped
- Pennie retains its production/customer data
- reusable Blind Bench software remains Mogil Ventures/Blind Bench IP
- no Pennie data is used for generic Blind Bench marketing, demos, shared eval packs, or shared model training without written approval
