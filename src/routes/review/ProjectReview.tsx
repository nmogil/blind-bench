import { useQuery } from "convex/react";
import { Link, Navigate, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, ClipboardList, FileText, Inbox } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(ts).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
}

function initials(name: string | null | undefined, fallback = "?"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return fallback;
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || fallback;
}

export function ProjectReview() {
  const { projectId } = useParams<{ projectId: string }>();
  const data = useQuery(
    api.reviewerHome.getProjectReview,
    projectId ? { projectId: projectId as Id<"projects"> } : "skip",
  );

  if (data === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // null = non-collaborator, blind reviewer, or missing project. Per #163
  // criterion #5, those get a 404/redirect.
  if (data === null) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <ProjectHeader name={data.project.name} description={data.project.description} />

      <LatestDraftCard
        currentVersion={data.currentVersion}
        orgSlug={data.project.orgSlug}
        projectId={data.project._id}
      />

      <RunsWaitingSection
        runs={data.runsWaiting}
        orgSlug={data.project.orgSlug}
        projectId={data.project._id}
      />

      <DraftsWaitingSection
        drafts={data.draftsWaiting}
        orgSlug={data.project.orgSlug}
        projectId={data.project._id}
      />
    </div>
  );
}

function ProjectHeader({
  name,
  description,
}: {
  name: string;
  description: string | null;
}) {
  return (
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </header>
  );
}

type CurrentVersion = NonNullable<
  NonNullable<
    ReturnType<typeof useQuery<typeof api.reviewerHome.getProjectReview>>
  >
>["currentVersion"];

function LatestDraftCard({
  currentVersion,
  orgSlug,
  projectId,
}: {
  currentVersion: CurrentVersion;
  orgSlug: string | null;
  projectId: Id<"projects">;
}) {
  if (!currentVersion) {
    return (
      <section className="rounded-lg border bg-card p-6">
        <EmptyState
          icon={FileText}
          heading="No draft yet"
          description="The author hasn't shared a draft on this prompt yet. You'll see it here once they do."
        />
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Latest draft
        </h2>
        <span className="text-xs text-muted-foreground">
          {formatDate(currentVersion.createdAt)}
        </span>
      </div>
      <article className="space-y-4 rounded-lg border bg-card p-5">
        <header className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={currentVersion.authorImage ?? undefined} />
            <AvatarFallback className="text-xs">
              {initials(currentVersion.authorName)}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs text-muted-foreground">
            by {currentVersion.authorName ?? "the author"}
          </span>
        </header>
        <div className="space-y-4">
          {currentVersion.messages.map((m) => (
            <MessageBlock
              key={m.id}
              role={m.role}
              content={m.role === "assistant" ? (m.content ?? "") : m.content}
            />
          ))}
        </div>
        {orgSlug && (
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/versions/${currentVersion.versionId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View full draft
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </article>
    </section>
  );
}

function MessageBlock({
  role,
  content,
}: {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}) {
  const label =
    role === "user" ? "User" : role === "assistant" ? "Assistant" : "System";
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="prose prose-sm max-w-none whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm leading-relaxed dark:prose-invert">
        {content ? (
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        ) : (
          <span className="text-xs italic text-muted-foreground">
            (empty)
          </span>
        )}
      </div>
    </div>
  );
}

type RunSummary = NonNullable<
  ReturnType<typeof useQuery<typeof api.reviewerHome.getProjectReview>>
>["runsWaiting"][number];

function RunsWaitingSection({
  runs,
  orgSlug,
  projectId,
}: {
  runs: RunSummary[];
  orgSlug: string | null;
  projectId: Id<"projects">;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Runs waiting for your feedback
      </h2>
      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/50 p-6">
          <EmptyState
            icon={Inbox}
            heading="You're all caught up"
            description="No runs are waiting for your feedback right now. New runs from the author will show up here automatically."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.runId}>
              <Link
                to={
                  orgSlug
                    ? `/orgs/${orgSlug}/projects/${projectId}/runs/${run.runId}`
                    : "#"
                }
                className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="h-7 w-7 shrink-0">
                    <AvatarImage src={run.triggeredByImage ?? undefined} />
                    <AvatarFallback className="text-xs">
                      {initials(run.triggeredByName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {run.testCaseName ?? "Untitled run"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {run.triggeredByName ?? "Author"} ·{" "}
                      {formatDate(run.completedAt)}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {run.outputsToReview} to review
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type DraftSummary = NonNullable<
  ReturnType<typeof useQuery<typeof api.reviewerHome.getProjectReview>>
>["draftsWaiting"][number];

function DraftsWaitingSection({
  drafts,
  orgSlug,
  projectId,
}: {
  drafts: DraftSummary[];
  orgSlug: string | null;
  projectId: Id<"projects">;
}) {
  if (drafts.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Drafts ready to review
      </h2>
      <ul className="space-y-2">
        {drafts.map((draft) => (
          <li key={draft.versionId}>
            <Link
              to={
                orgSlug
                  ? `/orgs/${orgSlug}/projects/${projectId}/versions/${draft.versionId}`
                  : "#"
              }
              className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-3 min-w-0">
                <ClipboardList className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    Draft from {formatDate(draft.createdAt)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {draft.authorName ?? "Author"} shipped a new draft
                  </p>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
