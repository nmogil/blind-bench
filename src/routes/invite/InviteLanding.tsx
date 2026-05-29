import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";

// M30: reviewer-role invites can be accepted without an account — the guest
// becomes an anonymous user that is registered as a blind evaluator.
function roleAllowsGuest(role: string): boolean {
  return role === "project_evaluator" || role === "cycle_reviewer";
}

type GuestInfo = { displayName?: string; email?: string };

type InviteMeta = {
  scope: "org" | "project" | "cycle";
  scopeName: string;
  role: string;
  email: string;
  shareable: boolean;
  // M26: undefined for non-reviewer roles.
  blindMode?: boolean;
  status: "pending" | "accepted" | "revoked" | "expired";
  inviterName: string;
  expiresAt: number;
};

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

  return <InviteAccept token={token} meta={meta} />;
}

function InviteAccept({ token, meta }: { token: string; meta: InviteMeta }) {
  const { signIn } = useAuthActions();
  // Self-reported attribution typed on the guest card. Held in this parent so
  // it survives the Unauthenticated → Authenticated flip after anonymous
  // sign-in; AuthenticatedAccept reads it to attribute the guest.
  const [guestInfo, setGuestInfo] = useState<GuestInfo>({});
  const [guestStarting, setGuestStarting] = useState(false);

  const startGuest = async (info: GuestInfo) => {
    setGuestInfo({
      displayName: info.displayName || undefined,
      email: info.email || meta.email || undefined,
    });
    setGuestStarting(true);
    try {
      // Mints a powerless anonymous user. The tree flips to Authenticated and
      // AuthenticatedAccept finishes the accept as a guest.
      await signIn("anonymous");
    } catch (err) {
      setGuestStarting(false);
      toast.error(friendlyError(err, "Couldn't start your review."));
    }
  };

  return (
    <>
      <InviteHeader meta={meta} />
      <Authenticated>
        <AuthenticatedAccept token={token} meta={meta} guestInfo={guestInfo} />
      </Authenticated>
      <Unauthenticated>
        <UnauthenticatedPath
          token={token}
          meta={meta}
          guestStarting={guestStarting}
          onGuestStart={startGuest}
        />
      </Unauthenticated>
      <AuthLoading>
        <Skeleton className="mt-6 h-10 w-full" />
      </AuthLoading>
    </>
  );
}

function InviteHeader({ meta }: { meta: InviteMeta }) {
  const reviewerRole = roleAllowsGuest(meta.role);
  const showBlindBadge = reviewerRole && meta.blindMode !== undefined;
  const verb =
    meta.scope === "cycle"
      ? "Evaluate"
      : meta.scope === "project"
        ? reviewerRole
          ? meta.blindMode === false
            ? "Review"
            : "Blind-review"
          : "Collaborate on"
        : "Join";
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {meta.inviterName} invited you to
      </p>
      <h1 className="text-xl font-semibold">
        {verb} {meta.scopeName}
      </h1>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Role: {readableRole(meta.role)}
          {meta.email ? ` · For ${meta.email}` : ""}
        </span>
        {showBlindBadge && (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 font-medium">
            {meta.blindMode ? "Blind review" : "Open review"}
          </span>
        )}
      </div>
      {showBlindBadge && (
        <p className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
          {meta.blindMode
            ? "You'll rate example responses without seeing the prompt or who wrote them — it keeps feedback honest."
            : "You'll see the full prompt and comment on example responses. The author acts on what you write."}
        </p>
      )}
    </div>
  );
}

function AuthenticatedAccept({
  token,
  meta,
  guestInfo,
}: {
  token: string;
  meta: InviteMeta;
  guestInfo: GuestInfo;
}) {
  const currentUser = useQuery(api.users.viewer) as
    | Doc<"users">
    | null
    | undefined;
  const acceptWithAuth = useMutation(api.invitations.acceptWithAuth);
  const acceptInviteAsGuest = useMutation(api.invitations.acceptInviteAsGuest);
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const ran = useRef(false);

  const isAnonymous = currentUser?.isAnonymous === true;
  const currentEmail = currentUser?.email?.toLowerCase() ?? null;
  const emailMismatch =
    !isAnonymous &&
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

    const run = isAnonymous
      ? acceptInviteAsGuest({
          token,
          displayName: guestInfo.displayName,
          email: guestInfo.email,
        }).then((res) =>
          navigate(routeForGuestAccepted(res), { replace: true }),
        )
      : acceptWithAuth({ token }).then((res) =>
          navigate(routeForAccepted(res, meta.blindMode), { replace: true }),
        );

    void run.catch((err) => {
      ran.current = false;
      setAccepting(false);
      if (isAnonymous) {
        // Most likely an account-only invite or a full shareable link.
        setGuestError(friendlyError(err, "Couldn't start your review."));
      } else {
        toast.error(friendlyError(err, "Failed to accept invitation."));
      }
    });
  }, [
    acceptInviteAsGuest,
    acceptWithAuth,
    currentUser,
    emailMismatch,
    guestInfo.displayName,
    guestInfo.email,
    isAnonymous,
    meta.blindMode,
    navigate,
    token,
  ]);

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

  if (guestError) {
    return (
      <div className="mt-6 space-y-3">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {guestError}
        </div>
        <Link
          to={`/auth/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}
          className={buttonVariants({ variant: "outline", className: "w-full" })}
        >
          Sign in with an account
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <Button disabled className="w-full">
        {accepting ? "Starting…" : "Starting…"}
      </Button>
    </div>
  );
}

function UnauthenticatedPath({
  token,
  meta,
  guestStarting,
  onGuestStart,
}: {
  token: string;
  meta: InviteMeta;
  guestStarting: boolean;
  onGuestStart: (info: GuestInfo) => void;
}) {
  const navigate = useNavigate();

  // Owner/editor and org invites genuinely need an account — keep the gate.
  if (!roleAllowsGuest(meta.role)) {
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

  // M30: reviewer invites — no account required.
  return <GuestStartCard starting={guestStarting} onStart={onGuestStart} />;
}

function GuestStartCard({
  starting,
  onStart,
}: {
  starting: boolean;
  onStart: (info: GuestInfo) => void;
}) {
  const [name, setName] = useState("");

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (starting) return;
        onStart({ displayName: name.trim() || undefined });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="guest-name" className="text-xs">
          Your name <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="guest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="So the author knows whose feedback this is"
          maxLength={80}
          autoComplete="name"
          disabled={starting}
        />
      </div>
      <Button type="submit" className="w-full" disabled={starting}>
        {starting ? "Starting…" : "Start reviewing"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        No account needed. Your progress saves as you go.
      </p>
    </form>
  );
}

// M30: guests are always routed to a review surface, never the authoring
// app. Owner/editor/org scopes are unreachable here — the accept gate rejects
// them for anonymous users.
function routeForGuestAccepted(res: {
  scope: "org" | "project" | "cycle";
  scopeId: string;
}): string {
  if (res.scope === "cycle") {
    return `/review/start/cycle/${res.scopeId}`;
  }
  return `/review/${res.scopeId}`;
}

function routeForAccepted(
  res: {
    scope: "org" | "project" | "cycle";
    scopeId: string;
    orgSlug: string | null;
    projectId: string | null;
  },
  blindMode: boolean | undefined,
): string {
  if (res.scope === "cycle") {
    return `/review/start/cycle/${res.scopeId}`;
  }
  if (res.scope === "project") {
    // M26: non-blind reviewers land on the simplified review home.
    if (blindMode === false) {
      return `/review/${res.scopeId}`;
    }
    // M29.2 follow-up: route directly to the project. Project invites no
    // longer auto-join the inviter's org, so falling through to "/" would
    // send the user to their own (newly-seeded) personal workspace
    // instead of the project they just accepted. ProjectLayout bounces
    // blind evaluators on to /eval; editors and owners stay on the project.
    if (res.orgSlug && res.projectId) {
      return `/orgs/${res.orgSlug}/projects/${res.projectId}`;
    }
    return "/";
  }
  // org: drop the user on the org dashboard they just joined.
  if (res.orgSlug) {
    return `/orgs/${res.orgSlug}`;
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
