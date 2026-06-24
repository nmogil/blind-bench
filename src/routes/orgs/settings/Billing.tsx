import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";
import { CreditCard, ExternalLink, Check } from "lucide-react";

export function Billing() {
  const { role } = useOrg();
  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }
  return <BillingPanel />;
}

function BillingPanel() {
  const { orgId } = useOrg();
  const overview = useQuery(api.billing.getBillingOverview, { orgId });
  const createCheckout = useAction(api.billing.createCheckout);
  const createPortal = useAction(api.billing.createCustomerPortal);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (overview === undefined) {
    return (
      <div className="p-6 max-w-3xl">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  async function startCheckout(packageKey: string) {
    setBusy(packageKey);
    setError("");
    try {
      const { url } = await createCheckout({ orgId, packageKey });
      window.location.href = url;
    } catch (err) {
      setError(friendlyError(err, "Could not start checkout. Please try again."));
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError("");
    try {
      const { url } = await createPortal({ orgId });
      window.location.href = url;
    } catch (err) {
      setError(friendlyError(err, "Could not open the billing portal."));
      setBusy(null);
    }
  }

  const { entitlement, remainingCredits, packages, ledger, trial, portalAvailable } =
    overview;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick a package to add monthly eval credits and reviewer seats. New
        workspaces start with {trial.evalCredits} free trial credits — no card
        required.
      </p>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      {/* Current plan summary */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard aria-hidden="true" className="h-4 w-4" />
            Current plan
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            {entitlement && entitlement.status === "active" ? (
              <span className="text-sky-700 dark:text-sky-300">
                {packages.find((p) => p.key === entitlement.packageKey)?.name ??
                  entitlement.packageKey}{" "}
                · active
              </span>
            ) : (
              <span className="text-muted-foreground">
                Trial — no active package
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {remainingCredits.toLocaleString()} eval credits remaining
          </p>
          {portalAvailable && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={busy === "portal"}
              onClick={openPortal}
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
              <ExternalLink aria-hidden="true" className="ml-1 h-3 w-3" />
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Packages */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {packages.map((p) => (
          <Card key={p.key}>
            <CardHeader>
              <CardTitle className="text-base">{p.name}</CardTitle>
              <p className="text-xs text-muted-foreground">{p.blurb}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-1 text-sm">
                {p.manualEnterprise ? (
                  <li className="text-muted-foreground">Custom volume & seats</li>
                ) : (
                  <>
                    <Feature>
                      {p.monthlyEvalCredits.toLocaleString()} eval credits / mo
                    </Feature>
                    <Feature>{p.reviewerSeats} reviewer seats</Feature>
                    <Feature>
                      {p.traceImportLimit.toLocaleString()} trace imports / mo
                    </Feature>
                    <Feature>{p.supportLevel} support</Feature>
                  </>
                )}
              </ul>
              {p.manualEnterprise ? (
                <a
                  href="mailto:sales@blindbench.dev"
                  className={cn(buttonVariants({ variant: "outline" }), "w-full")}
                >
                  Contact sales
                </a>
              ) : (
                <Button
                  className="w-full"
                  disabled={busy === p.key}
                  onClick={() => startCheckout(p.key)}
                >
                  {busy === p.key ? "Starting…" : `Choose ${p.name}`}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Ledger */}
      {ledger.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Credit history</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {ledger.map((row, i) => (
                <li key={i} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground">
                    {row.reason.replace(/_/g, " ")}
                    {row.packageKey ? ` · ${row.packageKey}` : ""}
                  </span>
                  <span
                    className={
                      row.creditDelta < 0
                        ? "text-violet-700 dark:text-violet-300"
                        : "text-sky-700 dark:text-sky-300"
                    }
                  >
                    {row.creditDelta > 0 ? "+" : ""}
                    {row.creditDelta.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" />
      <span>{children}</span>
    </li>
  );
}
