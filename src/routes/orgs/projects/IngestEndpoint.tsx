import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/ui/copy-button";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Radio, ShieldAlert, KeyRound, Settings2 } from "lucide-react";

type IngestToken = FunctionReturnType<
  typeof api.ingestTokens.listIngestTokens
>[number];

type IssueResult = FunctionReturnType<typeof api.ingestTokens.issueIngestToken>;

/** {CONVEX_SITE_URL}/otlp/v1/traces — httpActions serve on .convex.site, not .cloud. */
function deriveIngestUrl(): string {
  const raw = (import.meta.env.VITE_CONVEX_URL ?? "").trim();
  const siteUrl = raw.replace(".convex.cloud", ".convex.site");
  return siteUrl
    ? `${siteUrl}/otlp/v1/traces`
    : "https://<your-deployment>.convex.site/otlp/v1/traces";
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

export function IngestEndpoint() {
  const { projectId } = useProject();
  const tokens = useQuery(api.ingestTokens.listIngestTokens, { projectId });
  const issueToken = useMutation(api.ingestTokens.issueIngestToken);

  const ingestUrl = deriveIngestUrl();

  const [label, setLabel] = useState("Gateway token");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<IssueResult | null>(null);

  async function handleIssue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    // A prior full-token card is stale once a new token is issued — clear it.
    setIssued(null);
    try {
      const res = await issueToken({ projectId, label: label.trim() });
      setIssued(res);
    } catch (err) {
      setError(
        friendlyError(err, "Could not issue a token. Try again in a moment."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Radio aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Continuous ingest (OTLP)</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Push agent traces to Blind Bench automatically from Cloudflare AI
          Gateway or any OpenTelemetry source.
        </p>
      </header>

      <Card className="mt-6 border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert
              aria-hidden="true"
              className="h-4 w-4 text-amber-600 dark:text-amber-400"
            />
            Data boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Blind Bench{" "}
            <strong className="text-foreground">
              never holds your gateway credential
            </strong>
            . You issue a token here and add it to YOUR gateway config — we only
            receive what your gateway pushes.
          </p>
        </CardContent>
      </Card>

      {/* Ingest URL */}
      <section className="mt-6 space-y-1.5">
        <Label htmlFor="ingest-url">Ingest URL</Label>
        <div className="flex items-center gap-2">
          <Input
            id="ingest-url"
            value={ingestUrl}
            readOnly
            spellCheck={false}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <CopyButton
            text={ingestUrl}
            label="Copy"
            variant="inline"
            className="h-8 shrink-0 border border-input px-2.5"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Point your gateway's OTLP HTTP exporter at this endpoint.
        </p>
      </section>

      {/* Issue token */}
      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
          Ingest tokens
        </h2>

        <form onSubmit={handleIssue} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="token-label">Label</Label>
            <Input
              id="token-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Gateway token"
              maxLength={80}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Issuing…" : "Issue token"}
          </Button>
        </form>

        {error && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {issued && (
          <IssuedTokenCard
            token={issued.token}
            onDismiss={() => setIssued(null)}
          />
        )}

        <div className="mt-4">
          <TokenList tokens={tokens} />
        </div>
      </section>

      {/* Gateway setup */}
      <GatewaySetupCard ingestUrl={ingestUrl} />
    </div>
  );
}

function IssuedTokenCard({
  token,
  onDismiss,
}: {
  token: string;
  onDismiss: () => void;
}) {
  return (
    <Card className="mt-4 border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert
            aria-hidden="true"
            className="h-4 w-4 text-amber-600 dark:text-amber-400"
          />
          Copy this now — it won't be shown again
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs">
            {token}
          </code>
          <CopyButton
            text={token}
            label="Copy"
            variant="inline"
            className="h-8 shrink-0 border border-input px-2.5"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Store it in your gateway config as a bearer token. We only keep a
          masked preview — there is no way to retrieve the full value later.
        </p>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </CardContent>
    </Card>
  );
}

function TokenList({ tokens }: { tokens: IngestToken[] | undefined }) {
  if (tokens === undefined) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading tokens">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
        <span className="sr-only">Loading ingest tokens…</span>
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No ingest tokens yet — issue one to start receiving traces.
      </p>
    );
  }

  return (
    <div className="divide-y rounded-lg border">
      {tokens.map((t) => (
        <TokenRow key={t._id} token={t} />
      ))}
    </div>
  );
}

function TokenRow({ token }: { token: IngestToken }) {
  const revokeToken = useMutation(api.ingestTokens.revokeIngestToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleRevoke() {
    setBusy(true);
    setError("");
    try {
      await revokeToken({ tokenId: token._id });
    } catch (err) {
      setError(friendlyError(err, "Could not revoke this token. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className={cn("font-medium", token.revoked && "text-muted-foreground")}>
          {token.label}{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {token.preview}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Created {formatTimestamp(token.createdAt)} · Last used{" "}
          {token.lastUsedAt ? formatTimestamp(token.lastUsedAt) : "never"}
        </p>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      {token.revoked ? (
        <span className="text-xs font-medium text-muted-foreground">Revoked</span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handleRevoke}
          disabled={busy}
        >
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      )}
    </div>
  );
}

function GatewaySetupCard({ ingestUrl }: { ingestUrl: string }) {
  const snippet = [
    `OTLP endpoint: ${ingestUrl}`,
    `Header: Authorization: Bearer <your token>`,
    `Format: JSON`,
  ].join("\n");

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 aria-hidden="true" className="h-4 w-4 text-primary" />
          Gateway setup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <ol className="list-decimal space-y-2 pl-5">
          <li>Issue an ingest token above and copy it.</li>
          <li>
            In Cloudflare AI Gateway, enable the OpenTelemetry (OTLP) exporter
            and set its HTTP endpoint to the ingest URL above.
          </li>
          <li>
            Add an auth header{" "}
            <code className="text-foreground">
              Authorization: Bearer &lt;token&gt;
            </code>{" "}
            (or, if your source can't set that header, use{" "}
            <code className="text-foreground">
              x-blindbench-ingest-token: &lt;token&gt;
            </code>
            ).
          </li>
          <li>
            Send spans as <strong className="text-foreground">JSON</strong>{" "}
            (protobuf support is coming later).
          </li>
        </ol>

        <div className="relative">
          <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-3 pr-12 font-mono text-xs text-foreground">
            {snippet}
          </pre>
          <CopyButton
            text={snippet}
            label="Copy config"
            variant="overlay"
          />
        </div>

        <p>
          Once your gateway starts pushing gen_ai spans, incoming traces appear
          under this project's trajectories and review surfaces.
        </p>

        <p>
          <a
            href="https://developers.cloudflare.com/ai-gateway/observability/otel-integration/"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            Cloudflare AI Gateway OTel integration docs →
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
