# Privacy Policy

_Last updated: April 18, 2026_

This Privacy Policy explains how Mogil Ventures, LLC ("**Blind Bench**", "**we**", "**us**") collects, uses, and shares information when you use Blind Bench (the "**Service**"). It applies to everyone who interacts with the Service — including account holders, collaborators, and anonymous reviewers who open a shareable evaluation link.

## 1. Information we collect

**Information you give us directly**

- **Account information.** When you sign in with Google OAuth, we receive your email address, name, Google account ID, and profile image. When you sign in with a magic link, we receive your email address.
- **Organization and project data.** Organization names, project names, membership records, role assignments, and collaborator invitations.
- **Prompt content and evaluations.** Prompts, prompt versions, meta context, test cases, variables, run configurations, LLM outputs captured through the Service, evaluator annotations, feedback, and optimizer decisions. We call this your **User Content**.
- **Support correspondence.** Messages you send to us by email or through in-app feedback.

**Information collected automatically**

- **Usage and device data.** Page views, feature interactions, approximate geolocation (derived from IP address), browser type, device type, and operating system. We use PostHog and Vercel Analytics for this.
- **Session replays (PostHog).** We may record interactions with the product to diagnose bugs and improve UX. Prompt input fields are **masked by default** so that your prompt text does not appear in replays. IP addresses are truncated where supported.
- **Log data.** Convex (our backend) and Vercel (our hosting provider) log request metadata including timestamps, IP address, and endpoint. These logs are retained for a limited period for operational and security purposes.

**Information from third parties**

- **Authentication providers.** If you use Google OAuth, Google shares the account information listed above with us.
- **LLM providers (via your BYOK key).** When the Service calls an LLM on your behalf using your OpenRouter or comparable key, the provider returns outputs to us which we store as part of your User Content. We do not receive any additional personal data from the LLM provider.

**Information we intentionally do not collect**

- We do not collect payment card information (there is currently no direct paid billing). If that changes, we will update this policy.
- We do not knowingly collect information about children under 18.
- We do not use third-party advertising cookies or cross-site tracking pixels.

## 2. How we use information

We process information for the following purposes:

- **Provide the Service** — authenticate you, render your projects, route reviewer invites, execute runs against LLMs, and store results.
- **Secure the Service** — detect abuse, prevent unauthorized access, encrypt secrets (BYOK keys are encrypted at rest with AES-GCM), and investigate incidents.
- **Improve the Service** — understand how features are used, diagnose errors, and prioritize work. We rely on aggregated and pseudonymous analytics where possible.
- **Communicate with you** — send magic-link sign-in emails, service announcements, and responses to your support inquiries. We will not send marketing email without a clear opt-in.
- **Comply with law** — respond to lawful requests, enforce our Terms, and exercise or defend legal claims.

**Legal bases (for users in the EEA, UK, and Switzerland).** We rely on: performance of a contract (providing the Service you request), our legitimate interests (operating and securing the Service), your consent (where required, for example non-essential analytics in certain jurisdictions), and compliance with legal obligations.

## 3. How we share information

We do not sell personal information. We share information only as described below.

**Subprocessors.** We use the following third-party services to operate Blind Bench:

| Provider | Purpose | Data categories |
|---|---|---|
| Google | OAuth authentication | Account profile, email |
| Resend | Magic-link email delivery | Email address, magic link |
| Convex | Database and serverless backend | User Content, account data, encrypted BYOK keys |
| Vercel | Application hosting and edge CDN | Request logs, IP address, Vercel Analytics |
| PostHog | Product analytics and session replay | Usage events, truncated IP, masked replays |
| OpenRouter and downstream LLM providers (Anthropic, OpenAI, Google, etc.) | Model inference | Prompt content, variables, and outputs that you submit for a run, billed to your BYOK key |

Each of these providers is bound by its own privacy policy and, where applicable, a data processing agreement with us.

**Collaborators and reviewers.** User Content you submit within a project is visible to the collaborators of that project and to reviewers you invite via shareable links, subject to the blind-evaluation rules of the product (reviewers see outputs and annotations but not version, model, or author identifiers).

**Legal and safety.** We may disclose information if we believe in good faith that it is necessary to comply with law, enforce our Terms, or protect the rights, property, or safety of Blind Bench, our users, or others.

**Business transfers.** If we are involved in a merger, acquisition, financing, reorganization, bankruptcy, or sale of assets, information may be transferred as part of that transaction. We will provide notice before your information is transferred and becomes subject to a different privacy policy.

## 4. Cookies and similar technologies

We use a small number of first-party cookies and similar technologies for authentication, session management, and privacy-preserving product analytics. We do not use third-party advertising cookies. Where applicable regional law requires opt-in consent for non-essential analytics, we configure our analytics tools accordingly.

## 5. Data retention

We retain User Content for as long as your organization exists and for a reasonable period thereafter to allow for recovery from accidental deletion, to comply with legal obligations, and to resolve disputes. Server logs are typically retained for 30 days. Session replay recordings are typically retained for 30 days. Encrypted BYOK keys are retained until you remove them.

You can delete projects, prompts, test cases, and most other User Content through the product UI. If you want your entire account and organization deleted, contact us at [hello@blindbench.dev](mailto:hello@blindbench.dev) and we will process the request within a reasonable timeframe.

## 6. Security

We take reasonable administrative, technical, and organizational measures to protect information, including encryption in transit (TLS), encryption at rest for secrets (AES-GCM for BYOK keys), role-based access controls, and audit logging. No method of transmission or storage is perfectly secure, and we cannot guarantee absolute security. Please report suspected vulnerabilities to [security@blindbench.dev](mailto:security@blindbench.dev).

## 7. International data transfers

Blind Bench is operated from the United States, and our subprocessors may process data in the United States and elsewhere. If you access the Service from outside the United States, you acknowledge that your information may be transferred to, stored, and processed in the United States and other countries where privacy laws may differ from those of your jurisdiction. Where required, we rely on appropriate transfer mechanisms (such as Standard Contractual Clauses) with our subprocessors.

## 8. Your rights

Depending on where you live, you may have rights regarding your personal information, including:

- **Access** — request a copy of personal information we hold about you.
- **Correction** — ask us to correct inaccurate information.
- **Deletion** — ask us to delete your personal information, subject to exceptions.
- **Portability** — receive a copy of certain information in a structured, machine-readable format.
- **Objection / restriction** — object to or restrict certain processing.
- **Withdraw consent** — where processing is based on consent, withdraw that consent at any time.

To exercise these rights, email [hello@blindbench.dev](mailto:hello@blindbench.dev) from the email address associated with your account. We will respond within the period required by applicable law. You may also lodge a complaint with your local supervisory authority.

**California (CCPA/CPRA).** California residents may request to know, delete, and correct personal information, and to opt out of "sale" or "sharing" of personal information. We do not sell or share personal information as those terms are defined under California law. Authorized agents may submit requests with proof of authorization.

## 9. Children

The Service is not directed to children under 18, and we do not knowingly collect personal information from them. If you believe a child has provided us with personal information, please contact us and we will delete it.

## 10. Changes to this policy

We may update this Privacy Policy from time to time. If changes are material, we will provide reasonable notice — for example, by email to the address on your account or by posting a notice in the Service — before the changes take effect. The "Last updated" date at the top of this page shows when it was most recently revised.

## 11. Contact

Questions about this policy or your personal information:

Mogil Ventures, LLC
[hello@blindbench.dev](mailto:hello@blindbench.dev)
Security: [security@blindbench.dev](mailto:security@blindbench.dev)
