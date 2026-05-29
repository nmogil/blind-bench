import Google from "@auth/core/providers/google";
import { Resend } from "resend";
import { convexAuth } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    Google,
    // M30: no-account guest reviewers. `signIn("anonymous")` mints a powerless
    // user (isAnonymous: true) with NO memberships — it can see and do nothing
    // on its own. Authorization comes solely from the invite-validated
    // evaluator row written by `invitations.acceptInviteAsGuest`, which is the
    // real gate. So enabling this provider does not widen access; a bare anon
    // account is inert until it accepts a reviewer invite. Orphan anon accounts
    // (signed in, never accepted) are reaped by the cleanupAnonUsers cron.
    Anonymous,
    Email({
      id: "resend",
      authorize: undefined,
      async sendVerificationRequest({ identifier, url, token }) {
        if (!process.env.RESEND_API_KEY) {
          // In dev without Resend, log the OTP code so you can still sign in
          console.log(`[DEV] Magic link code for ${identifier}: ${token}`);
          return;
        }
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "Blind Bench <noreply@blindbench.dev>",
          to: identifier,
          subject: "Sign in to Blind Bench",
          html: `
            <h2>Sign in to Blind Bench</h2>
            <p>Click the link below to sign in:</p>
            <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Sign in</a></p>
            <p style="color:#666;font-size:14px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
          `,
        });
      },
    }),
  ],
});
