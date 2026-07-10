import { Link, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CloudDownload, FileInput, RadioTower } from "lucide-react";
import { ProjectSettingsNav } from "./ProjectSettingsNav";

/** Project-level entry points for file, API, and advanced Gateway ingestion. */
export function ProjectSources() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const projectBase = `/orgs/${orgSlug}/projects/${projectId}`;
  const orgBase = `/orgs/${orgSlug}`;

  return (
    <div className="flex">
      <ProjectSettingsNav />
      <div className="max-w-3xl flex-1 p-6">
        <header>
          <h1 className="text-2xl font-bold">Data sources</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add completed AI behavior by file or endpoint. Blind Bench stores and
            reviews runs; it does not execute your harness.
          </p>
        </header>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <SourceCard
            icon={FileInput}
            title="Upload completed runs"
            description="CSV, OpenTelemetry JSON, Pi sessions, and Claude Code transcripts."
            href={`${projectBase}/import`}
            action="Open file import"
          />
          <SourceCard
            icon={RadioTower}
            title="Continuous ingest"
            description="Send native eval-record v1 or OTLP events with a project-scoped token."
            href={`${projectBase}/ingest`}
            action="Configure endpoint"
          />
          <SourceCard
            icon={CloudDownload}
            title="Cloudflare AI Gateway"
            description="Advanced adapter for exported Gateway JSONL and scorecard materialization."
            href={`${orgBase}/gateway-import`}
            action="Open Gateway adapter"
          />
        </div>
      </div>
    </div>
  );
}

function SourceCard({
  icon: Icon,
  title,
  description,
  href,
  action,
}: {
  readonly icon: typeof FileInput;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly action: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Link
          to={href}
          className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
        >
          {action}
        </Link>
      </CardContent>
    </Card>
  );
}
