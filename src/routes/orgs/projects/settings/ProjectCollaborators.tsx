import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, UserPlus, Users, MailX } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { InviteDialog } from "@/components/InviteDialog";
import { Id } from "../../../../../convex/_generated/dataModel";
import { friendlyError } from "@/lib/errors";
import { ProjectSettingsNav } from "./ProjectSettingsNav";

type ProjectRole = "owner" | "editor" | "evaluator";

export function ProjectCollaborators() {
  const { projectId, role } = useProject();
  const [inviteOpen, setInviteOpen] = useState(false);

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return (
    <div className="flex">
      <ProjectSettingsNav />
      <div className="p-6 max-w-3xl flex-1">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Collaborators</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage who can access this prompt and their roles.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Evaluators can only see blinded outputs and leave feedback. They cannot
              see versions or know which version produced which output.
            </p>
          </div>
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite
          </Button>
        </div>

        <PendingInvitesTable projectId={projectId} />
        <CollaboratorTable projectId={projectId} />

        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          scope="project"
          scopeId={projectId as string}
          defaultRole="project_editor"
        />
      </div>
    </div>
  );
}

function PendingInvitesTable({ projectId }: { projectId: Id<"projects"> }) {
  const invites = useQuery(api.invitations.list, {
    scope: "project",
    scopeId: projectId as string,
  });
  const revoke = useMutation(api.invitations.revoke);

  if (invites === undefined) return null;
  const pending = invites.filter((i) => i.status === "pending");
  if (pending.length === 0) return null;

  async function handleRevoke(id: Id<"invitations">, email: string) {
    if (!confirm(`Revoke invitation for ${email || "link"}?`)) return;
    try {
      await revoke({ invitationId: id });
      toast.success("Invitation revoked.");
    } catch (err) {
      toast.error(friendlyError(err, "Failed to revoke invitation."));
    }
  }

  return (
    <div className="mt-6 space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Pending invites
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead className="w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pending.map((inv) => (
            <TableRow key={inv._id}>
              <TableCell className="text-sm">{inv.email || "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground capitalize">
                {inv.role.replace(/^project_/, "")}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDate(inv.invitedAt)}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleRevoke(inv._id, inv.email)}
                  aria-label="Revoke invitation"
                >
                  <MailX className="h-4 w-4 text-muted-foreground" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CollaboratorTable({ projectId }: { projectId: Id<"projects"> }) {
  const collaborators = useQuery(api.projects.listCollaborators, { projectId });
  const updateRole = useMutation(api.projects.updateCollaboratorRole);
  const remove = useMutation(api.projects.removeCollaborator);

  if (collaborators === undefined) {
    return (
      <div className="mt-6 space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (collaborators.length <= 1) {
    return (
      <div className="mt-6">
        <EmptyState
          icon={Users}
          heading="Just you so far"
          description="You're the only collaborator. Invite someone to start leaving feedback."
        />
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Collaborators
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Collaborator</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {collaborators.map((c) => (
            <TableRow key={c._id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={c.image ?? undefined} />
                    <AvatarFallback className="text-xs">
                      {c.name?.[0]?.toUpperCase() ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium">
                      {c.name ?? "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground">{c.email}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Select
                  value={c.role}
                  onValueChange={(value) =>
                    void updateRole({
                      projectId,
                      userId: c.userId,
                      role: value as ProjectRole,
                    })
                  }
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="evaluator">Evaluator</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (
                      confirm(
                        `Remove ${c.name ?? c.email} from this prompt?`,
                      )
                    ) {
                      void remove({ projectId, userId: c.userId });
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatDate(ts: number): string {
  const now = Date.now();
  const diffDays = Math.floor((now - ts) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
