"use node";

import { Resend } from "resend";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const SITE_URL = process.env.SITE_URL ?? "https://blindbench.dev";

const scopeValidator = v.union(
  v.literal("org"),
  v.literal("project"),
  v.literal("cycle"),
);

type Scope = "org" | "project" | "cycle";

function subjectFor(
  scope: Scope,
  scopeName: string,
  blindMode: boolean | undefined,
): string {
  if (scope === "org") return `You've been invited to join ${scopeName}`;
  if (scope === "project") {
    if (blindMode === false) {
      return `You've been invited to review ${scopeName}`;
    }
    if (blindMode === true) {
      return `You've been invited to blind-review ${scopeName}`;
    }
    return `You've been invited to collaborate on ${scopeName}`;
  }
  return `You've been invited to evaluate "${scopeName}"`;
}

function headlineFor(scope: Scope, blindMode: boolean | undefined): string {
  if (scope === "org") return "You're invited to join an organization";
  if (scope === "project") {
    if (blindMode === false) return "You're invited to review a prompt";
    if (blindMode === true)
      return "You're invited to blind-review a prompt";
    return "You're invited to collaborate";
  }
  return "You're invited to evaluate";
}

function bodyFor(
  scope: Scope,
  scopeName: string,
  inviterName: string,
  blindMode: boolean | undefined,
): string {
  if (scope === "org") {
    return `<p><strong>${inviterName}</strong> invited you to join <strong>${scopeName}</strong> on Blind Bench.</p>`;
  }
  if (scope === "project") {
    if (blindMode === false) {
      return `<p><strong>${inviterName}</strong> invited you to review <strong>${scopeName}</strong>.</p><p>You'll see the full prompt and leave feedback on example outputs. The author will act on what you write.</p>`;
    }
    if (blindMode === true) {
      return `<p><strong>${inviterName}</strong> invited you to blind-review <strong>${scopeName}</strong>.</p><p>Example outputs are shuffled and labeled to remove bias. Rate each one without seeing which draft produced it.</p>`;
    }
    return `<p><strong>${inviterName}</strong> invited you to collaborate on <strong>${scopeName}</strong>.</p>`;
  }
  return `<p><strong>${inviterName}</strong> invited you to evaluate the review cycle <strong>${scopeName}</strong>.</p><p>Outputs are shuffled and labeled to remove bias. Rate each one as best, acceptable, or weak.</p>`;
}

export const sendInvitationEmail = internalAction({
  args: {
    recipientEmail: v.string(),
    scope: scopeValidator,
    scopeName: v.string(),
    inviterName: v.string(),
    token: v.string(),
    blindMode: v.optional(v.boolean()),
  },
  handler: async (_ctx, args) => {
    const url = `${SITE_URL}/invite/${args.token}`;

    if (!process.env.RESEND_API_KEY) {
      console.log(
        `[DEV] Invitation email for ${args.recipientEmail} (${args.scope}, blind=${args.blindMode ?? "n/a"}): ${url}`,
      );
      return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "Blind Bench <noreply@blindbench.dev>",
      to: args.recipientEmail,
      subject: subjectFor(args.scope, args.scopeName, args.blindMode),
      html: `
        <h2>${headlineFor(args.scope, args.blindMode)}</h2>
        ${bodyFor(args.scope, args.scopeName, args.inviterName, args.blindMode)}
        <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Accept invitation</a></p>
        <p style="color:#666;font-size:14px;">This link expires in ${args.scope === "cycle" ? "14 days" : "7 days"}.</p>
      `,
    });
  },
});
