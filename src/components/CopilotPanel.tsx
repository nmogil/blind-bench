import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  Check,
  ChevronRight,
  ChevronsRight,
  ChevronsLeft,
  Link as LinkIcon,
  X,
  PencilLine,
  PlayCircle,
  MessageSquareText,
  Sparkles,
  Users,
  Wand2,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useOrg } from "@/contexts/OrgContext";
import { useOrgLayout } from "@/components/layouts/OrgLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

type StepId =
  | "write_prompt"
  | "run_eval"
  | "compare_model"
  | "promote_test_case";

interface StepDef {
  id: StepId;
  title: string;
  context: string;
  cta: string;
  targetHint: string;
  icon: LucideIcon;
}

// M29.7: ambient steps tuned for the welcome-screen flow. The collab nudge
// (M29.6) sits above this list as a higher-priority card; "Get feedback" is
// not represented here.
const STEPS: StepDef[] = [
  {
    id: "write_prompt",
    title: "Write your prompt",
    context:
      "Author the messages you want sent to the model. Use {{name}} to make values reusable across test cases.",
    cta: "Open editor",
    targetHint: "in the version editor",
    icon: PencilLine,
  },
  {
    id: "run_eval",
    title: "Run it",
    context:
      "Three outputs from the same model so you can spot inconsistencies. Inline BYOK fires only at this click.",
    cta: "Configure run",
    targetHint: "on the run page",
    icon: PlayCircle,
  },
  {
    id: "compare_model",
    title: "Compare a second model",
    context:
      "Mix & Match runs two or three models against the same prompt in one round. The differences show what actually changes when you swap the model.",
    cta: "Add a slot",
    targetHint: "in Mix & Match mode on the run page",
    icon: Wand2,
  },
  {
    id: "promote_test_case",
    title: "Save a test case",
    context:
      "Promote the inline values you've been running with to a saved test case so every future run uses the same input — and you can compare apples to apples.",
    cta: "Open test cases",
    targetHint: "on the test cases tab",
    icon: MessageSquareText,
  },
];

export function CopilotPanel() {
  const { org, orgId } = useOrg();
  const navigate = useNavigate();
  const { openNewProjectDialog } = useOrgLayout();
  const progress = useQuery(api.onboarding.copilotProgress, { orgId });
  const prefs = useQuery(api.userPreferences.get);
  const collabNudge = useQuery(api.onboarding.collabNudge, { orgId });
  const setCollapsed = useMutation(api.userPreferences.setCopilotCollapsed);
  const setDismissed = useMutation(api.userPreferences.setCopilotDismissed);
  const dismissCallout = useMutation(api.userPreferences.dismissCallout);
  const mintInvite = useMutation(api.invitations.mintShareableProjectInvite);

  const collapsed = prefs?.copilotCollapsed === true;
  const dismissed = prefs?.copilotDismissed === true;

  // M28.8: panel switches between two modes.
  //   "guidance" — pre-activation, render the five-step checklist.
  //   "suggestions" — post-activation, render forward-looking suggestions so
  //   the surface stays alive instead of disappearing forever.
  const mode: "guidance" | "suggestions" =
    progress?.firstActivationAt !== undefined ? "suggestions" : "guidance";

  const nextStepId: StepId | null = useMemo(() => {
    if (!progress) return null;
    if (mode !== "guidance") return null;
    return STEPS.find((s) => !progress.steps[s.id])?.id ?? null;
  }, [progress, mode]);

  if (dismissed) return null;

  const showCollabNudge = collabNudge?.shouldShow === true;

  const handleStep = (id: StepId) => {
    const slug = org.slug;
    const projectId = progress?.firstProjectId;
    switch (id) {
      case "write_prompt":
        if (projectId) {
          navigate(`/orgs/${slug}/projects/${projectId}/versions`);
        } else {
          openNewProjectDialog();
        }
        return;
      case "run_eval":
        if (projectId) {
          navigate(`/orgs/${slug}/projects/${projectId}/run`);
        } else {
          openNewProjectDialog();
        }
        return;
      case "compare_model":
        if (projectId) {
          navigate(`/orgs/${slug}/projects/${projectId}/run`);
        }
        return;
      case "promote_test_case":
        if (projectId) {
          navigate(`/orgs/${slug}/projects/${projectId}/test-cases`);
        }
        return;
    }
  };

  // Loading: only render the chrome, not skeleton steps inside the rail to avoid
  // layout flicker when prefs and progress arrive at slightly different times.
  if (!progress || !prefs) {
    return (
      <aside
        aria-label="Setup co-pilot"
        className="hidden shrink-0 border-l bg-background lg:flex lg:w-[280px] lg:flex-col"
      >
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-2 w-full" />
          <div className="space-y-2 pt-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside
        aria-label="Setup co-pilot (collapsed)"
        className="hidden shrink-0 border-l bg-background lg:flex lg:w-12 lg:flex-col lg:items-center lg:py-3"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void setCollapsed({ collapsed: false })}
                className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted"
                aria-label="Expand setup co-pilot"
              />
            }
          >
            <ChevronsLeft className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent side="left">Setup co-pilot</TooltipContent>
        </Tooltip>
        <div className="mt-3 flex flex-col items-center gap-1.5">
          {STEPS.map((step) => {
            const done = progress.steps[step.id];
            const isNext = step.id === nextStepId;
            return (
              <Tooltip key={step.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => handleStep(step.id)}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums",
                        done
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : isNext
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:bg-muted",
                      )}
                      aria-label={step.title}
                    />
                  }
                >
                  {done ? <Check className="h-3 w-3" /> : <step.icon className="h-3 w-3" />}
                </TooltipTrigger>
                <TooltipContent side="left">
                  <div className="font-medium">{step.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {done ? "Done" : isNext ? "Next" : "Up next"}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <div className="mt-auto pb-1 text-[10px] tabular-nums text-muted-foreground">
          {progress.doneCount}/{progress.totalCount}
        </div>
      </aside>
    );
  }

  const percent = progress.totalCount
    ? Math.round((progress.doneCount / progress.totalCount) * 100)
    : 0;

  return (
    <aside
      aria-label="Setup co-pilot"
      className="hidden shrink-0 border-l bg-background lg:flex lg:w-[300px] lg:flex-col"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">
            {mode === "suggestions" ? "What's next" : "Get to your first run"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {mode === "suggestions"
              ? "Forward-looking suggestions tuned to your workspace."
              : progress.isComplete
                ? "You've completed the loop."
                : "Auto-advances as you work."}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void setCollapsed({ collapsed: true })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Collapse co-pilot"
                />
              }
            >
              <ChevronsRight className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Collapse</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void setDismissed({ dismissed: true })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Dismiss co-pilot"
                />
              }
            >
              <X className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Hide (Help menu to restore)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {showCollabNudge && collabNudge?.shouldShow && (
        <CollabNudgeCard
          projectId={collabNudge.projectId}
          dismissKey={collabNudge.dismissKey}
          onMint={async () => {
            const { token } = await mintInvite({
              projectId: collabNudge.projectId,
            });
            const url = `${window.location.origin}/invite/${token}`;
            await navigator.clipboard.writeText(url);
            toast.success("Invite link copied to clipboard.");
          }}
          onDismiss={() => {
            void dismissCallout({ calloutKey: collabNudge.dismissKey });
          }}
        />
      )}

      {mode === "guidance" ? (
        <>
          <div className="border-b px-4 pb-3 pt-2">
            <div className="flex items-center gap-2">
              <div
                className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={progress.doneCount}
                aria-valuemin={0}
                aria-valuemax={progress.totalCount}
              >
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {progress.doneCount}/{progress.totalCount}
              </span>
            </div>
          </div>

          <ol className="flex-1 space-y-1.5 overflow-y-auto p-3">
            {STEPS.map((step, index) => (
              <CopilotStep
                key={step.id}
                step={step}
                index={index}
                done={progress.steps[step.id]}
                isNext={step.id === nextStepId}
                onClick={() => handleStep(step.id)}
              />
            ))}
          </ol>
        </>
      ) : (
        <SuggestionsView
          orgSlug={org.slug}
          firstProjectId={progress.firstProjectId}
          orgMemberCount={progress.orgMemberCount}
          onNewProject={openNewProjectDialog}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// M29.6 — high-priority collab nudge
// ---------------------------------------------------------------------------

function CollabNudgeCard({
  onMint,
  onDismiss,
}: {
  projectId: string;
  dismissKey: string;
  onMint: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-b border-primary/20 bg-primary/5 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Users className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Get feedback</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send a reviewer the link. They rate your run blind — that's where
            the real signal comes from, not running alone.
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              size="xs"
              onClick={async () => {
                if (minting) return;
                setMinting(true);
                try {
                  await onMint();
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2400);
                } catch {
                  // The mint mutation surfaces its own errors via toast.
                } finally {
                  setMinting(false);
                }
              }}
              disabled={minting}
            >
              <LinkIcon className="mr-1 h-3 w-3" />
              {copied ? "Copied!" : minting ? "Generating…" : "Copy invite link"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={onDismiss}
              className="text-muted-foreground"
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CopilotStep({
  step,
  index,
  done,
  isNext,
  onClick,
}: {
  step: StepDef;
  index: number;
  done: boolean;
  isNext: boolean;
  onClick: () => void;
}) {
  const Icon = step.icon;
  return (
    <li
      className={cn(
        "rounded-lg border transition-colors",
        done
          ? "border-border/50 bg-muted/30"
          : isNext
            ? "border-primary/40 bg-primary/5"
            : "border-border",
      )}
    >
      <div className="flex items-start gap-2.5 p-3">
        <div
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            done
              ? "bg-primary text-primary-foreground"
              : isNext
                ? "border border-primary text-primary"
                : "border border-border text-muted-foreground",
          )}
          aria-hidden
        >
          {done ? (
            <Check className="h-3 w-3" />
          ) : (
            <Icon className="h-3 w-3" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <p
              className={cn(
                "text-sm font-medium",
                done && "text-muted-foreground line-through",
              )}
            >
              {step.title}
            </p>
          </div>
          {!done && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                {step.context}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {step.targetHint}
                </span>
                <Button
                  size="xs"
                  variant={isNext ? "default" : "outline"}
                  onClick={onClick}
                >
                  {step.cta}
                  <ChevronRight className="ml-0.5 h-3 w-3" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// M28.8 — post-activation "what's next" surface
// ---------------------------------------------------------------------------

interface Suggestion {
  id: string;
  title: string;
  body: string;
  cta: string;
  icon: LucideIcon;
  onClick: () => void;
}

function SuggestionsView({
  orgSlug,
  firstProjectId,
  orgMemberCount,
  onNewProject,
}: {
  orgSlug: string;
  firstProjectId: Id<"projects"> | null;
  orgMemberCount: number;
  onNewProject: () => void;
}) {
  const navigate = useNavigate();

  // v1 ranking is intentionally simple — no ML, no LLM. Each suggestion
  // returns a `weight` from a quick state check; we sort desc and render
  // the top items so the surface feels responsive without any background work.
  const suggestions: Array<Suggestion & { weight: number }> = [
    {
      id: "invite_teammate",
      title: "Invite a teammate to review",
      body:
        "Blind feedback from a second person catches what you'd otherwise miss.",
      cta: "Invite",
      icon: Users,
      // Heavier weight when the workspace is solo — the gap is loudest there.
      weight: orgMemberCount <= 1 ? 100 : 30,
      onClick: () => navigate(`/orgs/${orgSlug}/settings/members`),
    },
    {
      id: "try_different_model",
      title: "Try a different model on this prompt",
      body:
        "Use Mix & Match to run the same prompt across two or three models in one round.",
      cta: "Open run",
      icon: Wand2,
      weight: firstProjectId ? 70 : 0,
      onClick: () => {
        if (!firstProjectId) {
          onNewProject();
          return;
        }
        navigate(`/orgs/${orgSlug}/projects/${firstProjectId}/run`);
      },
    },
    {
      id: "start_review_cycle",
      title: "Start a review cycle",
      body:
        "Pool runs from different versions and route them blind to evaluators.",
      cta: "New cycle",
      icon: Sparkles,
      weight: firstProjectId ? 50 : 0,
      onClick: () => {
        if (!firstProjectId) {
          onNewProject();
          return;
        }
        navigate(`/orgs/${orgSlug}/projects/${firstProjectId}/cycles/new`);
      },
    },
  ];

  const ranked = suggestions
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  return (
    <ul className="flex-1 space-y-1.5 overflow-y-auto p-3">
      {ranked.map((s) => {
        const Icon = s.icon;
        return (
          <li
            key={s.id}
            className="rounded-lg border border-border bg-background"
          >
            <div className="flex items-start gap-2.5 p-3">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
                <Icon className="h-3 w-3" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
                <div className="mt-2 flex justify-end">
                  <Button size="xs" variant="outline" onClick={s.onClick}>
                    {s.cta}
                    <ChevronRight className="ml-0.5 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
