import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
import { RoleBadge } from "@/components/RoleBadge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { CycleStatusPill } from "@/components/CycleStatusPill";
import {
  CheckCircle2,
  Circle,
  Key,
  Variable,
  FlaskConical,
  FileText,
  ArrowRight,
  Lightbulb,
  GitPullRequestArrow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OnboardingCallout } from "@/components/OnboardingCallout";

export function ProjectHome() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { project, projectId, role } = useProject();
  const { orgId, role: orgRole } = useOrg();
  const collaborators = useQuery(api.projects.listCollaborators, { projectId });
  const hasSoloOutputs = useQuery(api.soloEval.hasAvailableOutputs, {
    projectId,
  });
  const keyStatus = useQuery(api.openRouterKeys.hasKey, { orgId });
  const variables = useQuery(api.variables.list, { projectId });
  const testCases = useQuery(api.testCases.list, { projectId });
  const versions = useQuery(api.versions.list, { projectId });
  const allCycles = useQuery(
    api.reviewCycles.list,
    role !== "evaluator" ? { projectId } : "skip",
  );

  const isOwner = orgRole === "owner";
  const loading =
    keyStatus === undefined ||
    variables === undefined ||
    testCases === undefined ||
    versions === undefined;

  const hasKey = keyStatus?.hasKey ?? false;
  const hasVariables = (variables?.length ?? 0) > 0;
  const hasTestCases = (testCases?.length ?? 0) > 0;
  const hasVersions = (versions?.length ?? 0) > 0;

  const latestDraft = versions?.find((v) => v.status === "draft");
  const latestVersion = versions?.[0];

  // Determine which step is "next" (first incomplete)
  const steps = [
    ...(isOwner ? [{ key: "api-key", done: hasKey }] : []),
    { key: "variables", done: hasVariables },
    { key: "test-cases", done: hasTestCases },
    { key: "versions", done: hasVersions },
  ];
  const nextStep = steps.find((s) => !s.done)?.key ?? null;
  const allDone = steps.every((s) => s.done);

  return (
    <div className="flex">
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        {project.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {project.description}
          </p>
        )}

        {loading ? (
          <div className="mt-8 space-y-3 max-w-lg">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : allDone ? (
          /* All setup complete — show quick links */
          <div className="mt-8 max-w-lg space-y-4">
            <div className="rounded-lg border bg-green-50/50 dark:bg-green-950/10 p-4">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Prompt is set up</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                You're ready to write, run, and iterate on your prompt.
              </p>
            </div>

            <OnboardingCallout calloutKey="onboarding_shortcuts">
              Pro tip: Press ? to see keyboard shortcuts, or ⌘K to search
              anything.
            </OnboardingCallout>

            {/* Active Review Cycles */}
            {(() => {
              const openCycles = allCycles?.filter(
                (c) => c.status === "open",
              );
              if (!openCycles || openCycles.length === 0) return null;
              return (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <GitPullRequestArrow className="h-4 w-4 text-primary" />
                    Active Review Cycles
                  </h3>
                  {openCycles.map((cycle) => (
                    <Link
                      key={cycle._id}
                      to={`/orgs/${orgSlug}/projects/${projectId}/cycles/${cycle._id}`}
                      className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 hover:bg-primary/10 transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">
                            {cycle.name}
                          </p>
                          <CycleStatusPill status={cycle.status} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {cycle.evaluatorProgress.completed}/
                          {cycle.evaluatorProgress.total} evaluators complete
                        </p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              );
            })()}

            <div className="space-y-2">
              {latestDraft && (
                <QuickLink
                  to={`/orgs/${orgSlug}/projects/${projectId}/versions/${latestDraft._id}`}
                  label={`Continue editing v${latestDraft.versionNumber}`}
                  sublabel="Open your latest draft"
                />
              )}
              {latestVersion && !latestDraft && (
                <QuickLink
                  to={`/orgs/${orgSlug}/projects/${projectId}/versions/${latestVersion._id}`}
                  label={`View v${latestVersion.versionNumber}`}
                  sublabel="Open the current version"
                />
              )}
              <QuickLink
                to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
                label="Version history"
                sublabel={`${versions!.length} version${versions!.length === 1 ? "" : "s"}`}
              />
              <QuickLink
                to={`/orgs/${orgSlug}/projects/${projectId}/run`}
                label="Configure a new run"
                sublabel="Run your prompt across test cases and models"
              />
              <QuickLink
                to={`/orgs/${orgSlug}/projects/${projectId}/compare`}
                label="Compare versions"
                sublabel="Run versions side-by-side"
              />
              <QuickLink
                to={`/orgs/${orgSlug}/projects/${projectId}/cycles`}
                label="Review cycles"
                sublabel="Structured blind evaluation across versions"
              />
              <QuickLink
                to={`/orgs/${orgSlug}/projects/${projectId}/solo-eval`}
                label="Solo blind evaluation"
                sublabel="Rate your outputs without knowing which version produced them"
              />
            </div>

            {hasSoloOutputs && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <p className="text-sm font-medium">
                  Outputs ready for blind evaluation
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  You have unrated outputs across multiple runs. Evaluate them
                  blind to reduce familiarity bias.
                </p>
                <Link
                  to={`/orgs/${orgSlug}/projects/${projectId}/solo-eval`}
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Start solo evaluation
                </Link>
              </div>
            )}

            <HowItWorks />
          </div>
        ) : (
          /* Setup checklist */
          <div className="mt-8 max-w-lg space-y-4">
            <p className="text-sm text-muted-foreground">
              Complete these steps to start running your prompt:
            </p>

            <div className="space-y-1">
              {isOwner && (
                <SetupStep
                  done={hasKey}
                  isNext={nextStep === "api-key"}
                  icon={Key}
                  label="Set up your OpenRouter API key"
                  sublabel="Required to run prompts against LLM models"
                  to={`/orgs/${orgSlug}/settings/openrouter-key`}
                  doneLabel="API key configured"
                />
              )}
              <SetupStep
                done={hasVariables}
                isNext={nextStep === "variables"}
                icon={Variable}
                label="Define variables for your prompt template"
                sublabel="Placeholders like {{name}} that change per test case. Skip if your prompt is static."
                to={`/orgs/${orgSlug}/projects/${projectId}/variables`}
                doneLabel={`${variables?.length ?? 0} variable${(variables?.length ?? 0) === 1 ? "" : "s"} defined`}
                optional
              />
              <SetupStep
                done={hasTestCases}
                isNext={nextStep === "test-cases"}
                icon={FlaskConical}
                label="Create at least one test case"
                sublabel="A test case provides the input values your prompt will be tested with"
                to={`/orgs/${orgSlug}/projects/${projectId}/test-cases`}
                doneLabel={`${testCases?.length ?? 0} test case${(testCases?.length ?? 0) === 1 ? "" : "s"}`}
              />
              <SetupStep
                done={hasVersions}
                isNext={nextStep === "versions"}
                icon={FileText}
                label="Create your first prompt version"
                sublabel="Write your prompt, then run it to see 3 side-by-side outputs"
                to={
                  latestDraft
                    ? `/orgs/${orgSlug}/projects/${projectId}/versions/${latestDraft._id}`
                    : `/orgs/${orgSlug}/projects/${projectId}/versions`
                }
                doneLabel={
                  latestDraft
                    ? `Continue editing v${latestDraft.versionNumber}`
                    : `${versions?.length ?? 0} version${(versions?.length ?? 0) === 1 ? "" : "s"}`
                }
              />
            </div>

            <HowItWorks />
          </div>
        )}
      </div>

      {/* Collaborators sidebar */}
      <div className="w-64 shrink-0 border-l p-4">
        <h3 className="text-sm font-semibold">Collaborators</h3>
        <Separator className="my-2" />
        {collaborators === undefined ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {collaborators.map((c) => (
              <div key={c._id} className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={c.image ?? undefined} />
                  <AvatarFallback className="text-[10px]">
                    {c.name?.[0]?.toUpperCase() ?? "?"}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm truncate flex-1">
                  {c.name ?? c.email}
                </span>
                <RoleBadge role={c.role} />
              </div>
            ))}
          </div>
        )}
        {role === "owner" && (
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/settings/collaborators`}
            className="mt-3 block text-xs text-primary hover:underline"
          >
            Manage collaborators
          </Link>
        )}
      </div>
    </div>
  );
}

function SetupStep({
  done,
  isNext,
  icon: Icon,
  label,
  sublabel,
  to,
  doneLabel,
  optional,
}: {
  done: boolean;
  isNext: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sublabel: string;
  to: string;
  doneLabel: string;
  optional?: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
        done
          ? "border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-950/10"
          : isNext
            ? "border-primary/30 bg-primary/5 hover:bg-primary/10"
            : "border-border hover:bg-muted/50",
      )}
    >
      <div className="mt-0.5">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
        ) : (
          <Circle
            className={cn(
              "h-5 w-5",
              isNext ? "text-primary" : "text-muted-foreground/40",
            )}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              done ? "text-green-600 dark:text-green-400" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "text-sm font-medium",
              done && "text-green-700 dark:text-green-400",
            )}
          >
            {done ? doneLabel : label}
          </span>
          {optional && !done && (
            <span className="text-xs text-muted-foreground">(optional)</span>
          )}
        </div>
        {!done && (
          <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
        )}
      </div>
      {isNext && !done && (
        <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      )}
    </Link>
  );
}

function QuickLink({
  to,
  label,
  sublabel,
}: {
  to: string;
  label: string;
  sublabel: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors"
    >
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function HowItWorks() {
  return (
    <div className="rounded-lg border border-dashed p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb className="h-4 w-4 text-muted-foreground" />
        How it works
      </div>
      <ol className="mt-2 space-y-1.5 text-xs text-muted-foreground list-decimal list-inside">
        <li>Write a prompt template with variables</li>
        <li>
          Run it to generate 3 blind outputs (A, B, C) from the same model
        </li>
        <li>
          Comment on what works and what doesn't, then let the optimizer
          suggest a rewrite
        </li>
      </ol>
    </div>
  );
}
