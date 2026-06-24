import { Link } from "react-router-dom";
import { useOrg } from "@/contexts/OrgContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  ShieldAlert,
  FileCheck,
  Gauge,
  DollarSign,
  Terminal,
  Lock,
  Key,
  ArrowRight,
} from "lucide-react";

// Static read-only mirror of the local scorecard generator
// (src/lib/evals/scorecard.ts) for the synthetic customer-pilot smoke pack.
// No network / Convex / live data — regenerate the real artifacts with the CLI
// below. Numbers track the documented expected run; if the pack changes, update
// here and in docs/customer-ai-quality-scorecard-handoff.md.

const HEADLINE = [
  {
    icon: CheckCircle2,
    label: "Cases fully passing",
    value: "49 / 50",
    detail: "98% pass rate · mean quality score 0.9933",
  },
  {
    icon: ShieldAlert,
    label: "Safety / privacy hard-fails",
    value: "1",
    detail: "Blocking — gates promotion until resolved",
    alert: true,
  },
  {
    icon: FileCheck,
    label: "Missing fixtures",
    value: "0",
    detail: "Full pack coverage, nothing skipped",
  },
  {
    icon: Gauge,
    label: "Cost / latency cases",
    value: "10",
    detail: "Cases carrying synthetic cost & latency metrics",
  },
  {
    icon: Gauge,
    label: "Mean latency",
    value: "~1050 ms",
    detail: "Synthetic metadata · indicative only",
  },
  {
    icon: DollarSign,
    label: "Mean cost",
    value: "~$0.0015",
    detail: "Synthetic metadata · indicative only",
  },
];

const PRODUCTS = [
  {
    name: "Migo",
    tagline: "Example pilot surface — account assistant flows",
    status: "Blocked",
    blocking: true,
    notes:
      "One privacy hard-fail on a balance-inquiry case (cross-context leakage gate). Held out of promotion until remediated. All other cases on this surface pass.",
  },
  {
    name: "Eavesly",
    tagline: "Example pilot surface — knowledge & support flows",
    status: "Clear",
    blocking: false,
    notes:
      "No blocking safety/privacy findings and no soft quality issues in this run. Clears the gate for broader review.",
  },
];

export function PilotScorecard() {
  const { org, role } = useOrg();

  return (
    <div className="p-6 max-w-4xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Pilot scorecard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Customer-pilot readiness surface for the synthetic Migo / Eavesly
          smoke pack. This static snapshot was last refreshed on 2026-06-24;
          regenerate with the CLI below before sharing externally.
        </p>
      </div>

      {/* Headline metrics */}
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-3">
          Headline metrics
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {HEADLINE.map((m) => (
            <Card
              key={m.label}
              className={m.alert ? "border-amber-500/40 bg-amber-500/5" : ""}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <m.icon
                    aria-hidden="true"
                    className={`h-4 w-4 ${m.alert ? "text-amber-600 dark:text-amber-400" : ""}`}
                  />
                  {m.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{m.value}</div>
                <p className="mt-1 text-xs text-muted-foreground">{m.detail}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Product breakdown */}
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-3">
          Product breakdown
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {PRODUCTS.map((p) => (
            <Card key={p.name}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <Badge variant={p.blocking ? "destructive" : "secondary"}>
                    {p.status}
                  </Badge>
                </div>
                <CardDescription>{p.tagline}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{p.notes}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Hard-fail explanation */}
      <section>
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert aria-hidden="true" className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              Why the hard-fail stays visible
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              The single safety/privacy hard-fail is a cross-context leakage gate
              firing on one Migo case. It is intentionally surfaced and{" "}
              <span className="font-medium text-foreground">
                blocks promotion until resolved
              </span>{" "}
              — hard-fails are tracked separately from soft quality scores and
              never silently averaged away.
            </p>
            <p>
              By contract, this surface shows only the failing scorer
              (&nbsp;<code className="text-foreground">no_cross_context_leakage</code>&nbsp;)
              and the case label. It never renders raw prompts, model outputs,
              account identifiers, or scorer reason strings — those can echo the
              very forbidden value the scorer caught.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Next steps */}
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-3">
          In-app next steps
        </h2>
        <div className="rounded-lg border divide-y">
          {role === "owner" && (
            <Link
              to={`/orgs/${org.slug}/settings/openrouter-key`}
              className="flex items-center justify-between px-4 py-3 hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-3">
                <Key aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Model-key settings</p>
                  <p className="text-xs text-muted-foreground">
                    Manage the model provider key used for evaluation runs.
                  </p>
                </div>
              </div>
              <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            </Link>
          )}
          <Link
            to={`/orgs/${org.slug}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <FileCheck aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Open a prompt to run evals</p>
                <p className="text-xs text-muted-foreground">
                  Pick a prompt from the workspace to manage test cases and runs.
                </p>
              </div>
            </div>
            <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          </Link>
        </div>
      </section>

      {/* CLI handoff */}
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-3">
          Regenerate the scorecard
        </h2>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal aria-hidden="true" className="h-4 w-4" />
              CLI handoff
            </CardTitle>
            <CardDescription>
              Deterministic, local-only, no network or secrets. Treat this page as
              a point-in-time mirror and the generated artifacts as source of truth.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              <code>npm run scorecard:customer-pilot</code>
            </pre>
            <div className="text-xs text-muted-foreground">
              Generates (git-ignored — regenerate on demand):
              <ul className="mt-1 list-disc pl-5 space-y-0.5">
                <li>
                  <code className="text-foreground">
                    artifacts/customer-ai-quality-scorecard.md
                  </code>{" "}
                  — customer-facing scorecard
                </li>
                <li>
                  <code className="text-foreground">
                    artifacts/customer-ai-quality-scorecard.json
                  </code>{" "}
                  — same data, machine-readable
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Data boundary */}
      <section>
        <Card className="bg-muted/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock aria-hidden="true" className="h-4 w-4" />
              Data boundary
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Generated artifacts must stay management-safe: case IDs, product
            labels, scorer IDs, and aggregate counts only — no raw transcripts,
            identifiers, or secrets. Production logs stay customer-scoped and are
            never committed to this repository.
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
