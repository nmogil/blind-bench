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

function subjectFor(scope: Scope, scopeName: string): string {
  if (scope === "org") return `You've been invited to join ${scopeName}`;
  if (scope === "project")
    return `You've been invited to collaborate on ${scopeName}`;
  return `You've been invited to evaluate "${scopeName}"`;
}

function headlineFor(scope: Scope): string {
  if (scope === "org") return "You're invited to join an organization";
  if (scope === "project") return "You're invited to collaborate";
  return "You're invited to evaluate";
}

function bodyFor(scope: Scope, scopeName: string, inviterName: string): string {
  if (scope === "org") {
    return `<p><strong>${inviterName}</strong> invited you to join <strong>${scopeName}</strong> on Blind Bench.</p>`;
  }
  if (scope === "project") {
    return `<p><strong>${inviterName}</strong> invited you to collaborate on the prompt <strong>${scopeName}</strong>.</p>`;
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
  },
  handler: async (_ctx, args) => {
    const url = `${SITE_URL}/invite/${args.token}`;

    if (!process.env.RESEND_API_KEY) {
      console.log(
        `[DEV] Invitation email for ${args.recipientEmail} (${args.scope}): ${url}`,
      );
      return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "Blind Bench <noreply@blindbench.dev>",
      to: args.recipientEmail,
      subject: subjectFor(args.scope, args.scopeName),
      html: `
        <h2>${headlineFor(args.scope)}</h2>
        ${bodyFor(args.scope, args.scopeName, args.inviterName)}
        <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Accept invitation</a></p>
        <p style="color:#666;font-size:14px;">This link expires in ${args.scope === "cycle" ? "14 days" : "7 days"}.</p>
      `,
    });
  },
});
