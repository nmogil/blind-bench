# Pennie AI Quality Scorecard handoff

This is the customer-facing pilot scorecard template and payment handoff checklist for the first paid Pennie AI Quality Bench delivery.

## Repeatable scorecard command

Once the Pennie synthetic smoke pack and runner are available, generate artifacts with:

```bash
npx tsx src/lib/evals/cli.ts \
  --pack pennie/smoke \
  --source fixtures \
  --output artifacts/pennie-ai-quality-scorecard.json \
  --markdown artifacts/pennie-ai-quality-scorecard.md \
  --allow-failures
```

For an all-pass CI smoke run:

```bash
npx tsx src/lib/evals/cli.ts --pack pennie/smoke-pass --source fixtures
```

## Customer-facing scorecard sections

1. **Executive summary**
   - What was evaluated
   - Overall pass/fail summary
   - Notable hard-fails
   - Recommended decision

2. **Scope**
   - Apps/modules evaluated
   - Dataset source: synthetic, redacted production, or production-approved
   - Models/prompts compared
   - Review period

3. **Quality results**
   - Pass/fail count
   - Soft quality scores
   - Preference results if human comparison is available
   - Top failure modes

4. **Safety/privacy results**
   - Hard-fail count
   - Cross-context leakage findings
   - Forbidden tool/destructive-action findings
   - Redaction status

5. **Cost and latency**
   - Model/provider cost where available
   - Latency distribution or simple averages
   - Candidate savings opportunities

6. **Regression set updates**
   - New cases promoted
   - Cases ignored/not useful
   - Cases approved for training export, if any

7. **Fine-tuning readiness**
   - Available reviewed examples
   - Preference pairs
   - Missing labels
   - Recommended next data collection

8. **Next actions**
   - Prompt/model changes to try
   - Production trace ingestion follow-up
   - Human review follow-up
   - Agent harness trace follow-up

## Management-safe language rules

- Do not include raw call transcripts by default.
- Do not include account IDs, phone numbers, emails, SSNs, card numbers, addresses, or secrets.
- Refer to examples by stable case IDs.
- Separate hard-fail safety/privacy issues from softer quality issues.
- Avoid claiming fine-tuning is ready unless the data is reviewed and approved.

## Pilot payment handoff

The first Pennie pilot can be paid manually; Polar self-serve billing is not required for first value delivery.

Checklist:

- [ ] SOW/pilot scope confirmed.
- [ ] Data boundary rules accepted.
- [ ] Deliverables and success criteria confirmed.
- [ ] Scorecard generated and reviewed.
- [ ] Invoice/payment recipient confirmed.
- [ ] Payment path selected:
  - manual invoice/payment for pilot, or
  - Polar checkout once #236 is complete.
- [ ] Follow-up expansion tickets identified.

## Follow-up expansion tickets

After first scorecard delivery, prioritize:

- #220 real Cloudflare AI Gateway trace ingestion
- #234 human review console
- #233 agent harness traces
- #228 Fireworks training dataset compiler
- #236 Polar self-serve packages
