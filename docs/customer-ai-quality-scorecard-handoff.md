# Customer AI Quality Scorecard handoff

This is the customer-facing pilot scorecard template and payment handoff checklist for the first paid customer AI quality bench delivery.

## Repeatable scorecard command

Generate the management-safe scorecard artifacts (Markdown + JSON) with:

```bash
npm run scorecard:customer-pilot
```

This runs the synthetic `customer-pilot/smoke` pack through the local scorers and
writes (artifacts are git-ignored — regenerate on demand):

- `artifacts/customer-ai-quality-scorecard.md` — customer-facing scorecard
- `artifacts/customer-ai-quality-scorecard.json` — same data, machine-readable

It is deterministic and local-only: no network, no hosted infra, no timestamps,
so re-runs are byte-identical. The scorecard exposes only case IDs, product
labels, scorer IDs, and aggregate counts — never raw model outputs, transcripts,
or scorer reason strings (which could echo the forbidden values a hard-fail
scorer caught).

### Expected results (synthetic pilot pack)

The synthetic pack ships one intentional cross-context leakage fixture so the
hard-fail path is exercised:

- **49/50 cases fully passing** (98%), mean quality score `0.9933`
- **1 safety/privacy hard-fail** — `pilot-migo-balance-00` (`no_cross_context_leakage`), reported separately from soft quality scores
- 0 soft quality issues
- Cost/latency: 10 synthetic-metric cases, mean cost ~`$0.0015`, mean latency ~`1050 ms`
- Fine-tuning readiness: not ready (synthetic, unreviewed)

### Raw eval table (engineering view, not customer-facing)

The lower-level CLI still emits the raw per-case table — keep it internal, it
shows scorer reason strings:

```bash
npx tsx src/lib/evals/cli.ts --pack customer-pilot/smoke --allow-failures
# all-pass CI smoke variant:
npx tsx src/lib/evals/cli.ts --pack customer-pilot/smoke-pass
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

The first customer pilot can be paid manually; Polar self-serve billing is not required for first value delivery.

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
