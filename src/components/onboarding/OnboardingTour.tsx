import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { motion, type Transition } from "motion/react";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, Sparkles, ShieldCheck, MessageSquareQuote } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

const TOTAL_STEPS = 6;

const SPRING: Transition = { type: "spring", stiffness: 220, damping: 24 };

interface OnboardingTourProps {
  /** When provided, skip the auto-trigger logic and render in "reopened from settings" mode. */
  forceOpen?: boolean;
  onClose?: () => void;
}

/**
 * First-run onboarding tour (M27.8).
 *
 * Six-step dialog that compresses the first-run cliff (sign in → BYOK →
 * project → version → eval) into one funnel. Skippable + resumable from
 * Settings. Uses motion/react for staggered spring intros; reduced-motion
 * users get instant rendering.
 *
 * The component is hidden on /eval/* routes — evaluators get there via a
 * different funnel. Skipped silently if a user lands on the tour with
 * no first-class action available.
 *
 * Persistence lives in `userPreferences.tourStatus` / `tourStep`.
 */
export function OnboardingTour({ forceOpen, onClose }: OnboardingTourProps) {
  const prefs = useQuery(api.userPreferences.get);
  const setTourStatus = useMutation(api.userPreferences.setTourStatus);
  const orgs = useQuery(api.organizations.listMyOrgs);

  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);

  // Decide whether to auto-open the tour. Runs once when prefs + orgs load.
  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
      setStep(prefs?.tourStep ?? 0);
      return;
    }
    if (prefs === undefined || orgs === undefined) return;

    // Don't auto-trigger if the user is on the eval-only path (no orgs they own).
    // The blind-eval surface owns its own onboarding signal.
    if (orgs.length === 0) return;

    if (prefs.tourStatus === undefined || prefs.tourStatus === "unstarted") {
      setStep(0);
      setOpen(true);
      void setTourStatus({ status: "in_progress", step: 0 });
    } else if (prefs.tourStatus === "in_progress") {
      setStep(prefs.tourStep ?? 0);
      setOpen(true);
    }
  }, [prefs, orgs, forceOpen, setTourStatus]);

  const orgSlug = orgs?.[0]?.org.slug;
  const orgId = orgs?.[0]?.org._id;

  const close = (status: "skipped" | "completed") => {
    setOpen(false);
    void setTourStatus({ status, step });
    onClose?.();
  };

  const advance = () => {
    if (step >= TOTAL_STEPS - 1) {
      close("completed");
      return;
    }
    const next = step + 1;
    setStep(next);
    void setTourStatus({ status: "in_progress", step: next });
  };

  const back = () => {
    if (step <= 0) return;
    const prev = step - 1;
    setStep(prev);
    void setTourStatus({ status: "in_progress", step: prev });
  };

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => !v && close("skipped")}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <DialogTitle className="sr-only">Welcome to Blind Bench</DialogTitle>
        <div className="px-6 pt-6 pb-4">
          {/* Step indicator */}
          <div className="flex items-center gap-1 mb-4" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  i <= step ? "bg-primary" : "bg-muted",
                )}
              />
            ))}
          </div>

          <StepBody
            step={step}
            orgId={orgId ?? null}
            orgSlug={orgSlug ?? null}
            hasKey={!!prefs?.tourStatus}
            onAdvance={advance}
            onClose={() => close("skipped")}
          />

          <div className="flex items-center justify-between mt-6 pt-4 border-t">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => close("skipped")}
            >
              Skip tour
            </Button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <Button variant="ghost" size="sm" onClick={back}>
                  Back
                </Button>
              )}
              <NextButton step={step} orgId={orgId ?? null} onAdvance={advance} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface StepBodyProps {
  step: number;
  orgId: Id<"organizations"> | null;
  orgSlug: string | null;
  hasKey: boolean;
  onAdvance: () => void;
  onClose: () => void;
}

function StepBody({ step, orgId, orgSlug }: StepBodyProps) {
  switch (step) {
    case 0:
      return <WelcomeStep />;
    case 1:
      return <ByokStep orgId={orgId} />;
    case 2:
      return <CreateProjectStep orgSlug={orgSlug} />;
    case 3:
      return <FirstPromptStep orgSlug={orgSlug} />;
    case 4:
      return <FirstEvalStep orgSlug={orgSlug} />;
    case 5:
      return <DoneStep />;
    default:
      return null;
  }
}

function StaggerItem({
  delay,
  children,
}: {
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </motion.div>
  );
}

function WelcomeStep() {
  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">Welcome to Blind Bench</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Blind Bench is a collaborative prompt-engineering workspace. Run a
          prompt three ways, collect structured feedback from teammates, and
          let the optimizer turn that feedback into the next version — without
          letting reviewers see which model produced which output.
        </p>
      </StaggerItem>
      <StaggerItem delay={0.08}>
        <ul className="space-y-1.5 mt-3" aria-label="Key takeaways">
          <KeyTakeaway
            icon={<MessageSquareQuote className="h-4 w-4" />}
            text="Frictionless feedback — select text, comment, ship."
            tone="info"
          />
          <KeyTakeaway
            icon={<ShieldCheck className="h-4 w-4" />}
            text="BYOK — your OpenRouter key, encrypted at rest."
            tone="success"
          />
          <KeyTakeaway
            icon={<Sparkles className="h-4 w-4" />}
            text="Blind by default — reviewers never see version metadata."
            tone="warning"
          />
        </ul>
      </StaggerItem>
    </div>
  );
}

function KeyTakeaway({
  icon,
  text,
  tone,
}: {
  icon: React.ReactNode;
  text: string;
  tone: "info" | "success" | "warning";
}) {
  const bg =
    tone === "info"
      ? "bg-[var(--bg-info-tint)] text-info"
      : tone === "success"
        ? "bg-[var(--bg-success-tint)] text-success"
        : "bg-[var(--bg-warning-tint)]";
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          bg,
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="pt-1">{text}</span>
    </li>
  );
}

function ByokStep({ orgId }: { orgId: Id<"organizations"> | null }) {
  const setKey = useAction(api.openRouterKeys.setKey);
  const hasKey = useQuery(
    api.openRouterKeys.hasKey,
    orgId ? { orgId } : "skip",
  );
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!orgId || !value.trim()) return;
    setSaving(true);
    try {
      await setKey({ orgId, key: value.trim() });
      toast.success("Key saved.");
      setValue("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't save the key.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">Add your OpenRouter key</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Blind Bench uses BYOK — you pay providers directly, and we never
          touch your billing. Your key is encrypted at rest and only decrypted
          inside Convex actions.
        </p>
      </StaggerItem>
      <StaggerItem delay={0.08}>
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Get an OpenRouter key
          <ExternalLink className="h-3 w-3" />
        </a>
      </StaggerItem>
      <StaggerItem delay={0.12}>
        {hasKey ? (
          <div className="flex items-center gap-2 rounded-md border bg-[var(--bg-success-tint)] px-3 py-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" />
            Key on file. You can swap it any time from settings.
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="bb-tour-key">API key</Label>
            <div className="flex gap-2">
              <Input
                id="bb-tour-key"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-or-..."
                autoComplete="off"
              />
              <Button
                onClick={onSave}
                disabled={!value.trim() || saving || !orgId}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </StaggerItem>
    </div>
  );
}

function CreateProjectStep({ orgSlug }: { orgSlug: string | null }) {
  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">Create a project</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          A project is a workspace for one prompt and its iterations. Start
          one now — you can always come back here.
        </p>
      </StaggerItem>
      <StaggerItem delay={0.08}>
        {orgSlug ? (
          <Link
            to={`/orgs/${orgSlug}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open the projects list →
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sign in finishes setting up your workspace — give it a moment.
          </p>
        )}
      </StaggerItem>
    </div>
  );
}

function FirstPromptStep({ orgSlug }: { orgSlug: string | null }) {
  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">Write your first prompt</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use {"{{double-curly}}"} placeholders for any value the prompt
          should accept (e.g. <code className="rounded bg-muted px-1">
            {"Translate: {{text}}"}
          </code>). The Variables tab is where you describe each one.
        </p>
      </StaggerItem>
      <StaggerItem delay={0.08}>
        {orgSlug && (
          <p className="text-xs text-muted-foreground">
            We'll land you in the editor after the next step.
          </p>
        )}
      </StaggerItem>
    </div>
  );
}

function FirstEvalStep({ orgSlug }: { orgSlug: string | null }) {
  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">Run your first evaluation</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          From the version editor, click <strong>Run</strong> (⌘⏎). Three
          parallel calls stream into the eval grid. Select any phrase in an
          output to leave structured feedback — that feedback feeds the
          optimizer when you ask for the next draft.
        </p>
      </StaggerItem>
      <StaggerItem delay={0.08}>
        {orgSlug && (
          <Link
            to={`/orgs/${orgSlug}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Jump to the workspace →
          </Link>
        )}
      </StaggerItem>
    </div>
  );
}

function DoneStep() {
  return (
    <div className="space-y-3">
      <StaggerItem delay={0}>
        <h2 className="text-lg font-semibold">You're set</h2>
      </StaggerItem>
      <StaggerItem delay={0.04}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          That's the whole loop: run, review, optimize, accept. You can
          reopen this tour any time from <strong>Settings → Onboarding</strong>.
        </p>
      </StaggerItem>
    </div>
  );
}

function NextButton({
  step,
  orgId,
  onAdvance,
}: {
  step: number;
  orgId: Id<"organizations"> | null;
  onAdvance: () => void;
}) {
  const hasKey = useQuery(
    api.openRouterKeys.hasKey,
    orgId ? { orgId } : "skip",
  );
  // Step 1 (BYOK) blocks until a key is on file.
  const blocked = step === 1 && !hasKey;

  const label = useMemo(() => {
    if (step === TOTAL_STEPS - 1) return "Finish";
    return "Next";
  }, [step]);

  return (
    <Button onClick={onAdvance} disabled={blocked}>
      {label}
    </Button>
  );
}
