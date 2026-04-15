"use node";

import { Resend } from "resend";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const SITE_URL = process.env.SITE_URL ?? "https://blindbench.dev";

export const sendInvitationEmail = internalAction({
  args: {
    recipientEmail: v.string(),
    projectName: v.string(),
    cycleName: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    const shareableUrl = `${SITE_URL}/s/cycle/${args.token}`;

    if (!process.env.RESEND_API_KEY) {
      console.log(
        `[DEV] Eval invitation email for ${args.recipientEmail}: ${shareableUrl}`,
      );
      return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const cycleInfo = args.cycleName
      ? `<p>Review cycle: <strong>${args.cycleName}</strong></p>`
      : "";

    await resend.emails.send({
      from: "Blind Bench <noreply@blindbench.dev>",
      to: args.recipientEmail,
      subject: `You've been invited to evaluate prompt outputs for ${args.projectName}`,
      html: `
        <h2>You've been invited to evaluate</h2>
        <p>You've been invited to evaluate prompt outputs for <strong>${args.projectName}</strong>.</p>
        ${cycleInfo}
        <p>Outputs have been shuffled and labeled to remove bias. Rate each output as best, acceptable, or weak.</p>
        <p><a href="${shareableUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Start Evaluation</a></p>
        <p style="color:#666;font-size:14px;">This link expires in 48 hours. No account needed.</p>
      `,
    });
  },
});

export const sendInvitationReminderEmail = internalAction({
  args: {
    recipientEmail: v.string(),
    projectName: v.string(),
    cycleName: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (_ctx, args) => {
    const shareableUrl = `${SITE_URL}/s/cycle/${args.token}`;

    if (!process.env.RESEND_API_KEY) {
      console.log(
        `[DEV] Eval invitation reminder for ${args.recipientEmail}: ${shareableUrl}`,
      );
      return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const cycleInfo = args.cycleName
      ? `<p>Review cycle: <strong>${args.cycleName}</strong></p>`
      : "";

    await resend.emails.send({
      from: "Blind Bench <noreply@blindbench.dev>",
      to: args.recipientEmail,
      subject: `Reminder: Your evaluation for ${args.projectName} is waiting`,
      html: `
        <h2>Evaluation reminder</h2>
        <p>A reminder that you've been invited to evaluate prompt outputs for <strong>${args.projectName}</strong>.</p>
        ${cycleInfo}
        <p>Your evaluation is still waiting.</p>
        <p><a href="${shareableUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Start Evaluation</a></p>
        <p style="color:#666;font-size:14px;">This link expires in 48 hours.</p>
      `,
    });
  },
});
