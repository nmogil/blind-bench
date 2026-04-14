import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Trash2, UserPlus, Users } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Id } from "../../../../../convex/_generated/dataModel";
import { friendlyError } from "@/lib/errors";
import { ProjectSettingsNav } from "./ProjectSettingsNav";

type ProjectRole = "owner" | "editor" | "evaluator";

export function ProjectCollaborators() {
  const { projectId, role } = useProject();

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return (
    <div className="flex">
      <ProjectSettingsNav />
      <div className="p-6 max-w-3xl flex-1">
        <h1 className="text-2xl font-bold">Collaborators</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage who can access this prompt and their roles.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Evaluators can only see blinded outputs and leave feedback. They cannot
          see versions or know which version produced which output.
        </p>

        <InviteRow projectId={projectId} />
        <CollaboratorTable projectId={projectId} />
      </div>
    </div>
  );
}

function InviteRow({ projectId }: { projectId: Id<"projects"> }) {
  const inviteCollaborator = useMutation(api.projects.inviteCollaborator);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<ProjectRole>("editor");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const userLookup = useQuery(
    api.users.findByEmail,
    email.includes("@") ? { email: email.trim() } : "skip",
  );

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setInviting(true);
    setError("");
    setSuccess("");

    if (!userLookup) {
      setError("No user found with that email. They need to sign up first.");
      setInviting(false);
      return;
    }

    try {
      await inviteCollaborator({
        projectId,
        userId: userLookup._id,
        role: inviteRole,
      });
      setSuccess(`Invited ${email} as ${inviteRole}`);
      setEmail("");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(friendlyError(err, "Failed to send invite. Please try again."));
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="mt-4">
      <form onSubmit={handleInvite} className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            placeholder="Email address"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError("");
              setSuccess("");
            }}
          />
        </div>
        <Select
          value={inviteRole}
          onValueChange={(v) => setInviteRole(v as ProjectRole)}
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
        <Button type="submit" disabled={inviting || !email.trim()}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite
        </Button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {success && <p className="mt-2 text-sm text-green-600">{success}</p>}
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
