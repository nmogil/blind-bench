# Customer-test launch packet

Use this command to generate a single local handoff packet before the first customer testing session.

```bash
npm run launch:customer-test-packet
npm run launch:customer-test-packet -- --customer-label customer-test-01
npm run launch:customer-test-packet -- --customer-label customer-test-01 --json
```

Default artifacts:

```text
artifacts/customer-test-launch-packet/
├── customer-test-launch-packet.md
└── customer-test-launch-packet.json
```

## What the packet includes

The packet is generated from existing repo runbooks and docs. It includes:

- source docs checked;
- launch objective;
- first-session agenda;
- data-boundary commitments;
- operator/customer prerequisites;
- runbook links;
- go/no-go checklist;
- post-session follow-up checklist;
- caveats about approvals and local preflight.

## Source docs checked

- `docs/customer-pilot-sow.md`
- `docs/customer-ai-quality-scorecard-handoff.md`
- `docs/tenancy-consent-data-isolation.md`
- `docs/cloudflare-gateway-live-import.md`
- `docs/native-ingest.md`
- `docs/training-dataset-compiler.md`
- `docs/gateway-onboarding.md`

If any required source doc is missing, the packet reports `blocked_missing_sources` and exits non-zero.

## Customer label

`--customer-label` is sanitized, capped, and used only as a local packet label.

It is **not** approval evidence. Do not use a label to imply consent, vendor approval, or permission to import real logs.

## Safety contract

This command is local-only:

- no network calls;
- no Convex import or mutation;
- no Cloudflare calls;
- no Fireworks/model-provider calls;
- no customer trace content required or printed;
- no credentials required or printed.

The packet deliberately does not create or fake any approval record.

## Recommended operator flow

1. Run the packet generator with a neutral label.
2. Review the packet with the operator/customer team.
3. Confirm the legal/customer data boundary, reviewer scope, retention/deletion posture, and training-use posture outside committed source control.
4. Run local preflight on only approved operator-owned trace files.
5. Import only approved/redacted data into the scoped customer workspace.
6. Record imported counts, redaction caveats, review outcomes, and follow-up blockers.
