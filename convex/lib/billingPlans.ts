/**
 * Self-serve billing package configuration (Polar payments foundation).
 *
 * Single source of truth for what each package grants. Product IDs are NEVER
 * hard-coded here — they are resolved at runtime from environment variables
 * (one per package) so the same code runs against Polar sandbox and
 * production without edits. The frontend consumes this metadata via
 * `api.billing.getBillingOverview` rather than hard-coding product IDs or
 * credit counts in UI copy.
 *
 * Billing model (see docs/polar-self-serve-billing.md):
 *   - Packages: a monthly subscription that grants a fixed bundle of eval
 *     credits + reviewer seats + trace-import headroom + a support level.
 *   - Credits: a fungible per-eval unit tracked in `billingLedger`. A package
 *     purchase adds a positive ledger entry; a refund/revoke adds a negative
 *     one. Remaining credits = sum of all ledger deltas for the org.
 *   - Trial: every workspace starts with a small free credit grant (no card).
 *   - Manual enterprise: the largest tier is sales-assisted, not self-serve;
 *     `manualEnterprise: true` hides the self-serve checkout button.
 */

export type PackageKey = "starter" | "team" | "scale" | "enterprise";

export type SupportLevel = "community" | "standard" | "priority";

export interface BillingPackage {
  key: PackageKey;
  name: string;
  /** One-line value prop shown in the UI. */
  blurb: string;
  /**
   * Environment variable holding the Polar product ID for this package.
   * Resolved at runtime; absent => self-serve checkout fails closed.
   */
  productEnvVar: string;
  /** Eval credits granted per paid billing period. */
  monthlyEvalCredits: number;
  /** Reviewer seats included. */
  reviewerSeats: number;
  /** Max trace imports per billing period. */
  traceImportLimit: number;
  supportLevel: SupportLevel;
  /** True => sales-assisted only; no self-serve checkout. */
  manualEnterprise: boolean;
}

/**
 * Trial grant applied to a fresh workspace before any purchase. Represented in
 * config (not UI copy) so the same number drives the ledger seed and the UI.
 */
export const TRIAL = {
  evalCredits: 50,
  reviewerSeats: 2,
  traceImportLimit: 10,
} as const;

export const BILLING_PACKAGES: Record<PackageKey, BillingPackage> = {
  starter: {
    key: "starter",
    name: "Starter",
    blurb: "For individuals validating a single prompt.",
    productEnvVar: "POLAR_PRODUCT_STARTER",
    monthlyEvalCredits: 500,
    reviewerSeats: 3,
    traceImportLimit: 100,
    supportLevel: "community",
    manualEnterprise: false,
  },
  team: {
    key: "team",
    name: "Team",
    blurb: "For teams running regular blind evals.",
    productEnvVar: "POLAR_PRODUCT_TEAM",
    monthlyEvalCredits: 2500,
    reviewerSeats: 10,
    traceImportLimit: 1000,
    supportLevel: "standard",
    manualEnterprise: false,
  },
  scale: {
    key: "scale",
    name: "Scale",
    blurb: "For orgs with high eval volume.",
    productEnvVar: "POLAR_PRODUCT_SCALE",
    monthlyEvalCredits: 10000,
    reviewerSeats: 25,
    traceImportLimit: 5000,
    supportLevel: "priority",
    manualEnterprise: false,
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    blurb: "Custom volume, SSO, and a dedicated contact. Talk to us.",
    // No self-serve product; provisioned manually after a contract.
    productEnvVar: "POLAR_PRODUCT_ENTERPRISE",
    monthlyEvalCredits: 0,
    reviewerSeats: 0,
    traceImportLimit: 0,
    supportLevel: "priority",
    manualEnterprise: true,
  },
};

export const PACKAGE_ORDER: PackageKey[] = [
  "starter",
  "team",
  "scale",
  "enterprise",
];

export function isPackageKey(key: string): key is PackageKey {
  return key in BILLING_PACKAGES;
}

/** Lookup a package or return undefined. Callers throw their own user error. */
export function getPackage(key: string): BillingPackage | undefined {
  return isPackageKey(key) ? BILLING_PACKAGES[key] : undefined;
}

/**
 * Resolve the Polar product ID for a package from the environment. Returns
 * undefined when unset so callers can fail closed with a user-facing error.
 */
export function resolveProductId(
  pkg: BillingPackage,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[pkg.productEnvVar];
}

/**
 * Public, secret-free view of the catalog for the UI. Never includes resolved
 * product IDs — those stay server-side.
 */
export function publicPackageCatalog() {
  return PACKAGE_ORDER.map((key) => {
    const p = BILLING_PACKAGES[key];
    return {
      key: p.key,
      name: p.name,
      blurb: p.blurb,
      monthlyEvalCredits: p.monthlyEvalCredits,
      reviewerSeats: p.reviewerSeats,
      traceImportLimit: p.traceImportLimit,
      supportLevel: p.supportLevel,
      manualEnterprise: p.manualEnterprise,
    };
  });
}
