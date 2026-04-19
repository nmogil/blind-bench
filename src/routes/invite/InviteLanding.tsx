import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";

type InviteMeta = {
  scope: "org" | "project" | "cycle";
  scopeName: string;
  role: string;
  email: string;
  shareable: boolean;
  status: "pending" | "accepted" | "revoked" | "expired";
  inviterName: string;
  expiresAt: number;
};

const GUEST_IDENTITY_STORAGE_KEY = "bb:guestIdentityId";

function readableRole(role: string): string {
  return role
    .replace(/^cycle_/, "")
    .replace(/^project_/, "")
    .replace(/^org_/, "")
    .replace(/_/g, " ");
}

export function InviteLanding() {
  const { token } = useParams<{ token: string }>();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">
        {token ? (
          <InviteContent token={token} />
        ) : (
          <InvalidTokenState />
        )}
      </div>
    </div>
  );
}

function InviteContent({ token }: { token: string }) {
  const meta = useQuery(api.invitations.lookupByToken, { token }) as
    | InviteMeta
    | null
    | undefined;

  if (meta === undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (meta === null) return <InvalidTokenState />;
  if (meta.status === "revoked") return <RevokedState />;
  if (meta.status === "expired") return <ExpiredState />;
  if (!meta.shareable && meta.status === "accepted")
    return <AlreadyAcceptedState />;

  return (
    <>
      <InviteHeader meta={meta} />
      <Authenticated>
        <AuthenticatedAccept token={token} meta={meta} />
      </Authenticated>
      <Unauthenticated>
        <UnauthenticatedPath token={token} meta={meta} />
      </Unauthenticated>
      <AuthLoading>
        <Skeleton className="mt-6 h-10 w-full" />
      </AuthLoading>
    </>
  );
}

function InviteHeader({ meta }: { meta: InviteMeta }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {meta.inviterName} invited you to
      </p>
      <h1 className="text-xl font-semibold">
        {meta.scope === "cycle"
          ? "Evaluate"
          : meta.scope === "project"
            ? "Collaborate on"
            : "Join"}{" "}
        {meta.scopeName}
      </h1>
      <p className="text-xs text-muted-foreground">
        Role: {readableRole(meta.role)}
        {meta.email ? ` · For ${meta.email}` : ""}
      </p>
    </div>
  );
}

function AuthenticatedAccept({
  token,
  meta,
}: {
  token: string;
  meta: InviteMeta;
}) {
  const currentUser = useQuery(api.users.viewer) as
    | Doc<"users">
    | null
    | undefined;
  const acceptWithAuth = useMutation(api.invitations.acceptWithAuth);
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState(false);
  const ran = useRef(false);

  const currentEmail = currentUser?.email?.toLowerCase() ?? null;
  const emailMismatch =
    !meta.shareable &&
    meta.email &&
    currentEmail &&
    meta.email.toLowerCase() !== currentEmail;

  useEffect(() => {
    if (ran.current) return;
    if (!currentUser) return;
    if (emailMismatch) return;
    ran.current = true;
    setAccepting(true);
    void acceptWithAuth({ token })
      .then((res) => {
        navigate(routeForAccepted(res), { replace: true });
      })
      .catch((err) => {
        ran.current = false;
        setAccepting(false);
        toast.error(friendlyError(err, "Failed to accept invitation."));
      });
  }, [acceptWithAuth, currentUser, emailMismatch, navigate, token]);

  if (emailMismatch) {
    return (
      <div className="mt-6 space-y-3">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          This invitation was sent to <strong>{meta.email}</strong>, but
          you're signed in as <strong>{currentEmail}</strong>. Sign out and
          sign in with the invited email to accept.
        </div>
        <Link
          to="/"
          className={buttonVariants({
            variant: "outline",
            className: "w-full",
          })}
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <Button disabled className="w-full">
        {accepting ? "Accepting…" : "Accepting…"}
      </Button>
    </div>
  );
}

function UnauthenticatedPath({
  token,
}: {
  token: string;
  meta: InviteMeta;
}) {
  const navigate = useNavigate();

  // Guest acceptance is intentionally gated behind sign-in until the
  // reviewSessions pipeline supports guestIdentityId end-to-end. The schema
  // + invitations.acceptAsGuest path are in place; the review deck isn't.
  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-muted-foreground">
        Sign in to accept this invitation. If you don't have an account,
        you'll be prompted to create one.
      </p>
      <Button
        className="w-full"
        onClick={() =>
          navigate(
            `/auth/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`,
          )
        }
      >
        Sign in to continue
      </Button>
    </div>
  );
}

function GuestAcceptFlow({
  token,
  meta,
}: {
  token: string;
  meta: InviteMeta;
}) {
  const acceptAsGuest = useMutation(api.invitations.acceptAsGuest);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const needsEmail = meta.shareable;

  async function handleContinueAsGuest() {
    if (needsEmail && !email.trim()) {
      toast.error("Enter your email to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await acceptAsGuest({
        token,
        email: needsEmail ? email.trim() : undefined,
        displayName: displayName.trim() || undefined,
      });
      // Stash the guest identity so review-session mutations can attribute.
      if (res.guestIdentityId) {
        window.localStorage.setItem(
          GUEST_IDENTITY_STORAGE_KEY,
          res.guestIdentityId,
        );
      }
      navigate(routeForAccepted(res), { replace: true });
    } catch (err) {
      setSubmitting(false);
      toast.error(friendlyError(err, "Failed to accept invitation."));
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        Continue as a guest — no account needed. We'll attribute your feedback
        to your email.
      </p>
      {needsEmail && (
        <div className="space-y-1.5">
          <Label htmlFor="guest-email" className="text-xs">
            Your email
          </Label>
          <Input
            id="guest-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="guest-name" className="text-xs">
          Display name <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="guest-name"
          placeholder="Jane Doe"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={submitting}
        />
      </div>
      <Button
        className="w-full"
        onClick={handleContinueAsGuest}
        disabled={submitting}
      >
        {submitting ? "Starting…" : "Continue as guest"}
      </Button>
      <div className="text-center text-xs text-muted-foreground">
        or{" "}
        <Link
          to={`/auth/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}
          className="underline hover:text-foreground"
        >
          sign in to an existing account
        </Link>
      </div>
    </div>
  );
}

function routeForAccepted(res: {
  scope: "org" | "project" | "cycle";
  scopeId: string;
}): string {
  if (res.scope === "cycle") {
    return `/review/start/cycle/${res.scopeId}`;
  }
  if (res.scope === "project") {
    // Project routes are nested under an org slug we don't know yet; land on
    // dashboard and let the root redirect bounce the user into the right org.
    return "/";
  }
  return "/";
}

function InvalidTokenState() {
  return (
    <div className="space-y-3 text-center">
      <h1 className="text-lg font-semibold">Invitation not found</h1>
      <p className="text-sm text-muted-foreground">
        This link is invalid or no longer exists. Ask the person who sent it
        for a new invitation.
      </p>
      <Link
        to="/"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
      >
        Back to home
      </Link>
    </div>
  );
}

function RevokedState() {
  return (
    <div className="space-y-3 text-center">
      <h1 className="text-lg font-semibold">Invitation revoked</h1>
      <p className="text-sm text-muted-foreground">
        This invitation has been revoked. Ask for a new one.
      </p>
      <Link
        to="/"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
      >
        Back to home
      </Link>
    </div>
  );
}

function ExpiredState() {
  return (
    <div className="space-y-3 text-center">
      <h1 className="text-lg font-semibold">Invitation expired</h1>
      <p className="text-sm text-muted-foreground">
        This invitation has expired. Ask the sender for a new one.
      </p>
      <Link
        to="/"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
      >
        Back to home
      </Link>
    </div>
  );
}

function AlreadyAcceptedState() {
  return (
    <div className="space-y-3 text-center">
      <h1 className="text-lg font-semibold">Already accepted</h1>
      <p className="text-sm text-muted-foreground">
        You've already accepted this invitation.
      </p>
      <Link
        to="/"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
      >
        Back to home
      </Link>
    </div>
  );
}
