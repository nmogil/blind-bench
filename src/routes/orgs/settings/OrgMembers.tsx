import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
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
import { Trash2, UserPlus, MailX } from "lucide-react";
import { toast } from "sonner";
import { InviteDialog } from "@/components/InviteDialog";
import { Id } from "../../../../convex/_generated/dataModel";
import { friendlyError } from "@/lib/errors";

type OrgRole = "owner" | "admin" | "member";

export function OrgMembers() {
  const { orgId, role } = useOrg();
  const [inviteOpen, setInviteOpen] = useState(false);

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage who has access to this organization.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Invite member
        </Button>
      </div>

      <PendingInvitesTable orgId={orgId} />
      <MemberTable orgId={orgId} />

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope="org"
        scopeId={orgId as string}
        defaultRole="org_member"
      />
    </div>
  );
}

function PendingInvitesTable({ orgId }: { orgId: Id<"organizations"> }) {
  const invites = useQuery(api.invitations.list, {
    scope: "org",
    scopeId: orgId as string,
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
                {inv.role.replace(/^org_/, "")}
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

function MemberTable({ orgId }: { orgId: Id<"organizations"> }) {
  const members = useQuery(api.organizations.listMembers, { orgId });
  const updateMemberRole = useMutation(api.organizations.updateMemberRole);
  const removeMember = useMutation(api.organizations.removeMember);

  if (members === undefined) {
    return (
      <div className="mt-6 space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Members
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m._id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={m.image ?? undefined} />
                    <AvatarFallback className="text-xs">
                      {m.name?.[0]?.toUpperCase() ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium">
                      {m.name ?? "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Select
                  value={m.role}
                  onValueChange={(value) =>
                    void updateMemberRole({
                      orgId,
                      userId: m.userId,
                      role: value as OrgRole,
                    })
                  }
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
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
                        `Remove ${m.name ?? m.email} from the organization?`,
                      )
                    ) {
                      void removeMember({ orgId, userId: m.userId });
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
