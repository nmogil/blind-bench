import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
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
import { Trash2, UserPlus } from "lucide-react";
import { Id } from "../../../../convex/_generated/dataModel";
import { friendlyError } from "@/lib/errors";

type OrgRole = "owner" | "admin" | "member";

export function OrgMembers() {
  const { orgId, role } = useOrg();

  if (role !== "owner") {
    return <Navigate to="/denied" replace />;
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Members</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage who has access to this organization.
      </p>

      <InviteRow orgId={orgId} />
      <MemberTable orgId={orgId} />
    </div>
  );
}

function InviteRow({ orgId }: { orgId: Id<"organizations"> }) {
  const inviteMember = useMutation(api.organizations.inviteMember);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
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
      await inviteMember({
        orgId,
        userId: userLookup._id,
        role: inviteRole,
      });
      setSuccess(`Invited ${email}`);
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
          onValueChange={(v) => setInviteRole(v as OrgRole)}
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
