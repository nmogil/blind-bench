import { Link } from "react-router-dom";
import { useOrg } from "@/contexts/OrgContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plug,
  ListChecks,
  Tags,
  Download,
  PlayCircle,
  GitPullRequestArrow,
  FileBarChart,
  KeyRound,
  ShieldAlert,
  Terminal,
  MousePointerClick,
  ExternalLink,
} from "lucide-react";

const STEPS = [
  {
    icon: ListChecks,
    title: "Choose products & use cases",
    detail:
      "Pick the AI surfaces to onboard first. Start with one or two high-traffic prompts per product so the baseline is meaningful.",
  },
  {
    icon: Tags,
    title: "Add metadata to Gateway requests",
    detail:
      "Tag each request with the conventions below so logs can be grouped by product, module, and prompt version when they land in Blind Bench.",
  },
  {
    icon: Download,
    title: "Export / import Gateway logs",
    detail:
      "Pull logs from Cloudflare AI Gateway (dashboard export or API) and import them as test cases. Synthetic or redacted samples only in this slice.",
  },
  {
    icon: PlayCircle,
    title: "Run a baseline eval",
    detail:
      "Run the imported cases against the current production prompt to establish a baseline scorecard you can compare candidates to.",
  },
  {
    icon: GitPullRequestArrow,
    title: "Review & promote cases",
    detail:
      "Blind-review outputs, then promote the strongest cases into a durable review set the team can re-run on every change.",
  },
  {
    icon: FileBarChart,
    title: "Publish a scorecard",
    detail:
      "Generate a customer-facing quality scorecard from the baseline run and share it as the handoff artifact.",
  },
  {
    icon: KeyRound,
    title: "Add Fireworks credentials & candidate model (later)",
    detail:
      "Once a baseline exists, wire a Fireworks-hosted candidate model to A/B against production. Not required for this slice — see the callout below.",
    later: true,
  },
] as const;

const PRODUCTS = [
  {
    name: "Migo",
    blurb: "Conversational assistant surface.",
    cases: [
      "intent classification on inbound messages",
      "grounded answer drafting from a knowledge snippet",
      "tone / safety rewrite before send",
    ],
    metadata: { product: "migo", module: "assistant", variant: "control" },
  },
  {
    name: "Eavesly",
    blurb: "Summarization & extraction surface.",
    cases: [
      "call / thread summarization",
      "structured field extraction into JSON",
      "follow-up action suggestion",
    ],
    metadata: { product: "eavesly", module: "summarizer", variant: "control" },
  },
] as const;

// Cloudflare keeps at most 5 metadata entries per request and silently drops the
// rest, so the default set is exactly these five, trace_id first. Everything else
// (module, release, environment, session_id, …) belongs in a sidecar keyed by trace_id.
const METADATA_FIELDS = [
  { key: "trace_id", desc: "Request trace id — always first; it is the only log↔app correlation key." },
  { key: "tenant", desc: "Tenant label for attribution and per-tenant isolation." },
  { key: "product", desc: "Top-level product, e.g. migo / eavesly." },
  { key: "prompt_version", desc: "Version tag of the prompt that produced the output." },
  { key: "variant", desc: "control / candidate (which arm of an A/B)." },
] as const;

const CLI_SNIPPET = `# Request path: attach compact metadata before the AI Gateway call
# (max 5 keys — Cloudflare drops the rest; trace_id must be one of them)
METADATA='{"trace_id":"<trace>","tenant":"<tenant>","product":"migo","prompt_version":"2026-06-01","variant":"control"}'
curl https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/chat/completions
  -H "cf-aig-metadata: $METADATA"
  -d '{ "model": "gpt-4o-mini", "messages": [ ... ] }'

# Import path: export Gateway logs, then normalize them into Blind Bench
curl "https://api.cloudflare.com/client/v4/accounts/<account>/ai-gateway/gateways/<gateway>/logs"

# Then run the local importer / eval runner for the selected pack.`

export function GatewayOnboarding() {
  const { org } = useOrg();
  const base = `/orgs/${org.slug}`;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Plug aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Gateway onboarding</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Feed Cloudflare AI Gateway logs into Blind Bench so production prompt
          traffic becomes a measurable, reviewable eval set.
        </p>
      </header>

      {/* Data boundary — management-safe */}
      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert aria-hidden="true" className="h-4 w-4 text-amber-600" />
            Data boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Repo & demo:</strong> synthetic or
            redacted samples only. Never commit real prompts, outputs, or customer
            content.
          </p>
          <p>
            <strong className="text-foreground">prod_sensitive:</strong> real
            production logs must stay customer-scoped inside the workspace. They
            cannot be committed to the repo or shared outside the engagement.
          </p>
        </CardContent>
      </Card>

      {/* Checklist */}
      <section className="mt-8" aria-labelledby="checklist-heading">
        <h2 id="checklist-heading" className="text-lg font-semibold">
          Onboarding checklist
        </h2>
        <ol className="mt-3 space-y-3">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="flex gap-3 rounded-lg border p-4"
            >
              <step.icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">
                    {i + 1}. {step.title}
                  </h3>
                  {"later" in step && step.later && (
                    <Badge variant="secondary">later</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Product examples */}
      <section className="mt-8" aria-labelledby="products-heading">
        <h2 id="products-heading" className="text-lg font-semibold">
          Example products & use cases
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Synthetic examples to model your own onboarding. Replace with your real
          surfaces inside the workspace.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {PRODUCTS.map((p) => (
            <Card key={p.name}>
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <p className="text-xs text-muted-foreground">{p.blurb}</p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {p.cases.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(p.metadata, null, 2)}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Metadata conventions */}
      <section className="mt-8" aria-labelledby="metadata-heading">
        <h2 id="metadata-heading" className="text-lg font-semibold">
          Metadata conventions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Attach these keys to every Gateway request. AI Gateway custom metadata
          is limited in count and size — keep values short and put anything larger
          (full prompt text, long ids, structured context) in a{" "}
          <strong className="text-foreground">sidecar record</strong> keyed by{" "}
          <code className="text-foreground">trace_id</code> rather than inline.
        </p>
        <dl className="mt-3 divide-y rounded-lg border">
          {METADATA_FIELDS.map((f) => (
            <div key={f.key} className="grid grid-cols-3 gap-2 px-4 py-2 text-sm">
              <dt className="font-mono text-xs text-foreground">{f.key}</dt>
              <dd className="col-span-2 text-muted-foreground">{f.desc}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Required permissions */}
      <section className="mt-8" aria-labelledby="perms-heading">
        <h2 id="perms-heading" className="text-lg font-semibold">
          Required Cloudflare permissions
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">AI Gateway — Read</strong> to export
            request logs.
          </li>
          <li>
            <strong className="text-foreground">AI Gateway — Edit</strong> if you
            configure gateways or metadata rules.
          </li>
          <li>
            An <strong className="text-foreground">API token</strong> scoped to the
            specific account and gateway — not a global key.
          </li>
        </ul>
      </section>

      {/* Two paths */}
      <section className="mt-8" aria-labelledby="paths-heading">
        <h2 id="paths-heading" className="text-lg font-semibold">
          Two ways to feed logs in
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MousePointerClick aria-hidden="true" className="h-4 w-4" />
                No-code / manual
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ol className="list-decimal space-y-1 pl-4">
                <li>Open the AI Gateway dashboard for the account.</li>
                <li>Filter logs by product / time window.</li>
                <li>Export the log set (CSV/JSON).</li>
                <li>Import as test cases in a Blind Bench project.</li>
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal aria-hidden="true" className="h-4 w-4" />
                CLI / API
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs leading-relaxed">
                {CLI_SNIPPET}
              </pre>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Fireworks — later */}
      <Card className="mt-8 border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound aria-hidden="true" className="h-4 w-4 text-primary" />
            Where Fireworks credentials enter (later)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            After a baseline scorecard exists, a Fireworks-hosted candidate model
            is added to run head-to-head against production. That step needs a
            Fireworks API key configured in the workspace.
          </p>
          <p>
            <strong className="text-foreground">This slice does not require
            Fireworks credentials.</strong>{" "}
            You can complete every step above — including export, baseline, review,
            and scorecard — before adding a candidate-model key.
          </p>
        </CardContent>
      </Card>

      {/* Footer links */}
      <div className="mt-8 flex flex-wrap gap-4 border-t pt-4 text-sm">
        <Link
          to={`${base}/gateway-import`}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          Import Gateway logs →
        </Link>
        <Link
          to={`${base}/settings/openrouter-key`}
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          BYOK / model key settings
        </Link>
        <a
          href="https://developers.cloudflare.com/ai-gateway/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Cloudflare AI Gateway docs
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
