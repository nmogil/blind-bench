import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { genMessageId } from "./lib/messages";
import {
  SAMPLE_ANNOTATIONS,
  SAMPLE_OPTIMIZER_MODEL,
  SAMPLE_OPTIMIZER_PROMPT_VERSION,
  SAMPLE_OPTIMIZER_REASONING,
  SAMPLE_OPTIMIZER_SUMMARY,
  SAMPLE_OPTIMIZER_SYSTEM,
  SAMPLE_OPTIMIZER_USER_TEMPLATE,
  SAMPLE_OUTPUTS,
  SAMPLE_PROJECT_DESCRIPTION,
  SAMPLE_PROJECT_NAME,
  SAMPLE_REVIEWER_EMAIL,
  SAMPLE_REVIEWER_NAME,
  SAMPLE_SYSTEM_MESSAGE,
  SAMPLE_TEST_CASE_DRAFT,
  SAMPLE_TEST_CASE_NAME,
  SAMPLE_USER_TEMPLATE,
  SAMPLE_VARIABLE_NAME,
} from "./fixtures/sampleProject";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

function defaultPersonalOrgName(user: Doc<"users"> | null): string {
  const name = user?.name?.trim();
  if (name) return `${name.split(" ")[0]}'s workspace`;
  return "My workspace";
}

function slugCandidate(base: string, suffix: string): string {
  const cleaned = base
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const root = cleaned.length >= 3 ? cleaned : "workspace";
  const candidate = `${root}-${suffix}`.slice(0, 48);
  if (SLUG_REGEX.test(candidate)) return candidate;
  return `workspace-${suffix}`.slice(0, 48);
}

/**
 * Ensure the current user has a starter project seeded.
 *
 * Idempotent. Creates a personal org + a fully-populated starter project the
 * user owns and can edit/run from minute zero, and returns its slug.
 *
 * M29.3: rows are no longer written with a sample flag. The starter project
 * is fully mutable and indistinguishable structurally from a hand-built
 * project. M29.4 will move invocation from the auto-seed-on-login path to the
 * welcome screen's "Show me an example" CTA.
 *
 * M29.1: gating on workspace ownership rather than "any organizationMembers
 * row" so invite flows that create memberships don't accidentally suppress
 * seeding for a brand-new user. The two checks below are deliberately
 * separate signals:
 *
 *   1. `organizations.createdById === userId` (primary) — onboarding state.
 *      "Do you own a personal workspace?" If yes, you've already been
 *      through first-run.
 *   2. Any `organizationMembers` row (defensive secondary gate) — landing
 *      surface. "Do you have somewhere to land?" Catches the case where a
 *      user accepts an org invite *before* logging in for the first time;
 *      they don't own a workspace, but the inviter's org is enough — don't
 *      double-seed a personal one alongside it.
 *
 * Project- and cycle-invite acceptance writes to `projectCollaborators`
 * only (see invitations.ts three-rings comment), so neither trips gate (2).
 * Returns `{ orgSlug, sampleProjectId, alreadySeeded }`.
 */
export const ensureFirstRunSeed = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);

    const ownedOrg = await findUserOwnedOrg(ctx, userId);
    if (ownedOrg) {
      const starter = await findStarterProjectInOrg(ctx, ownedOrg._id);
      return {
        orgSlug: ownedOrg.slug,
        sampleProjectId: starter?._id ?? null,
        alreadySeeded: true,
      };
    }

    const existingMembership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    if (existingMembership) {
      const org = await ctx.db.get(existingMembership.organizationId);
      const starter = await findStarterProjectInOrg(
        ctx,
        existingMembership.organizationId,
      );
      return {
        orgSlug: org?.slug ?? null,
        sampleProjectId: starter?._id ?? null,
        alreadySeeded: true,
      };
    }

    const { orgId, slug } = await createPersonalOrg(ctx, userId);

    const sampleProjectId = await materializeSampleProject(ctx, orgId, userId);

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "starter project seeded",
      distinctId: userId as string,
      properties: {
        org_id: orgId as string,
        project_id: sampleProjectId as string,
      },
    });

    return {
      orgSlug: slug,
      sampleProjectId,
      alreadySeeded: false,
    };
  },
});

/**
 * M29.1: "Does this user own a personal workspace?" — the canonical
 * onboarding-completion signal. Distinct from membership; see
 * ensureFirstRunSeed for the rationale.
 */
export async function findUserOwnedOrg(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_creator", (q) => q.eq("createdById", userId))
    .first();
}

/**
 * M29.4: Create a personal workspace for a brand-new user, with a slug
 * derived from their display name and a defensive collision-retry loop.
 * Used by both the welcome screen mutations (createFromPaste, cloneStarter)
 * and the legacy ensureFirstRunSeed path.
 */
export async function createPersonalOrg(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<{ orgId: Id<"organizations">; slug: string }> {
  const user = await ctx.db.get(userId);
  const orgName = defaultPersonalOrgName(user);

  let slug = slugCandidate(orgName, userId.slice(-6));
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!clash) break;
    slug = slugCandidate(orgName, `${userId.slice(-6)}-${attempt + 2}`);
  }

  const orgId = await ctx.db.insert("organizations", {
    name: orgName,
    slug,
    createdById: userId,
  });
  await ctx.db.insert("organizationMembers", {
    organizationId: orgId,
    userId,
    role: "owner",
  });

  return { orgId, slug };
}

/**
 * M29.3: Returns the user's first project in this org (the starter, if it
 * was auto-seeded; otherwise the earliest project they have). Used by
 * `getMySampleProject` to route first-run users into a concrete editor.
 */
async function findStarterProjectInOrg(
  ctx: { db: QueryCtx["db"] },
  orgId: Id<"organizations">,
): Promise<Doc<"projects"> | null> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .take(50);
  if (projects.length === 0) return null;
  return projects
    .slice()
    .sort((a, b) => a._creationTime - b._creationTime)[0]!;
}

async function getOrCreateSampleReviewer(
  ctx: MutationCtx,
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", SAMPLE_REVIEWER_EMAIL))
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("users", {
    name: SAMPLE_REVIEWER_NAME,
    email: SAMPLE_REVIEWER_EMAIL,
  });
}

export async function materializeSampleProject(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
): Promise<Id<"projects">> {
  const projectId = await ctx.db.insert("projects", {
    organizationId: orgId,
    name: SAMPLE_PROJECT_NAME,
    description: SAMPLE_PROJECT_DESCRIPTION,
    createdById: userId,
  });

  await ctx.db.insert("projectCollaborators", {
    projectId,
    userId,
    role: "owner",
    invitedById: userId,
    invitedAt: Date.now(),
    acceptedAt: Date.now(),
  });

  await ctx.db.insert("projectVariables", {
    projectId,
    name: SAMPLE_VARIABLE_NAME,
    description: "The customer reply that should be rewritten warmer.",
    required: true,
    order: 0,
    type: "text",
  });

  const testCaseId = await ctx.db.insert("testCases", {
    projectId,
    name: SAMPLE_TEST_CASE_NAME,
    variableValues: { [SAMPLE_VARIABLE_NAME]: SAMPLE_TEST_CASE_DRAFT },
    attachmentIds: [],
    order: 0,
    createdById: userId,
  });

  const systemId = genMessageId();
  const userMsgId = genMessageId();
  const versionId = await ctx.db.insert("promptVersions", {
    projectId,
    versionNumber: 1,
    systemMessage: SAMPLE_SYSTEM_MESSAGE,
    userMessageTemplate: SAMPLE_USER_TEMPLATE,
    systemMessageFormat: "plain",
    userMessageTemplateFormat: "plain",
    messages: [
      {
        id: systemId,
        role: "system",
        content: SAMPLE_SYSTEM_MESSAGE,
        format: "plain",
      },
      {
        id: userMsgId,
        role: "user",
        content: SAMPLE_USER_TEMPLATE,
        format: "plain",
      },
    ],
    status: "current",
    createdById: userId,
  });

  const now = Date.now();
  const runId = await ctx.db.insert("promptRuns", {
    projectId,
    promptVersionId: versionId,
    testCaseId,
    // #188: seeded runs carry an input snapshot like real dispatches, so the
    // sample run's "what we sent" view doesn't show the legacy fallback note.
    inputSnapshot: {
      text: { [SAMPLE_VARIABLE_NAME]: SAMPLE_TEST_CASE_DRAFT },
    },
    model: SAMPLE_OUTPUTS[0]!.model,
    temperature: 0.7,
    mode: "mix",
    slotConfigs: SAMPLE_OUTPUTS.map((o) => ({
      label: o.blindLabel,
      model: o.model,
      temperature: 0.7,
    })),
    status: "completed",
    startedAt: now - 4000,
    completedAt: now - 1000,
    triggeredById: userId,
  });

  const outputIds: Id<"runOutputs">[] = [];
  for (const out of SAMPLE_OUTPUTS) {
    const outputId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: out.blindLabel,
      outputContent: out.content,
      model: out.model,
      temperature: 0.7,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 1200,
    });
    outputIds.push(outputId);
  }

  const reviewerId = await getOrCreateSampleReviewer(ctx);
  for (const annotation of SAMPLE_ANNOTATIONS) {
    const outputId = outputIds[annotation.outputIndex];
    if (!outputId) continue;
    await ctx.db.insert("outputFeedback", {
      outputId,
      userId: reviewerId,
      annotationData: {
        from: annotation.from,
        to: annotation.to,
        highlightedText: annotation.highlightedText,
        comment: annotation.comment,
      },
      label: annotation.label,
      targetKind: "inline",
    });
  }

  await ctx.db.insert("optimizationRequests", {
    projectId,
    promptVersionId: versionId,
    status: "completed",
    generatedSystemMessage: SAMPLE_OPTIMIZER_SYSTEM,
    generatedUserTemplate: SAMPLE_OPTIMIZER_USER_TEMPLATE,
    generatedMessages: [
      {
        id: genMessageId(),
        role: "system",
        content: SAMPLE_OPTIMIZER_SYSTEM,
        format: "plain",
      },
      {
        id: genMessageId(),
        role: "user",
        content: SAMPLE_OPTIMIZER_USER_TEMPLATE,
        format: "plain",
      },
    ],
    changesSummary: SAMPLE_OPTIMIZER_SUMMARY,
    changesReasoning: SAMPLE_OPTIMIZER_REASONING,
    optimizerModel: SAMPLE_OPTIMIZER_MODEL,
    optimizerPromptVersion: SAMPLE_OPTIMIZER_PROMPT_VERSION,
    reviewStatus: "pending",
    requestedById: userId,
  });

  return projectId;
}

/**
 * Surface the current user's first accessible project so RootRedirect can
 * land first-run users in a concrete editor.
 *
 * Walks `projectCollaborators` by user (not org membership) so project-invite-
 * only acceptors — who have no `organizationMembers` row under the M29.2
 * three-rings model — still resolve to the project they were invited to
 * instead of dead-ending on /welcome.
 *
 * `hasNonSampleProject` reflects whether the user has access to more than one
 * project — once true, RootRedirect drops the deep-link into the first
 * version and lands them on the org home instead.
 */
export const getMySampleProject = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);

    const accessibleProjects: Array<{
      project: Doc<"projects">;
      orgSlug: string | null;
    }> = [];

    for (const c of collabs) {
      const project = await ctx.db.get(c.projectId);
      if (!project) continue;
      const org = await ctx.db.get(project.organizationId);
      accessibleProjects.push({ project, orgSlug: org?.slug ?? null });
    }

    if (accessibleProjects.length === 0) {
      return { sample: null, hasNonSampleProject: false };
    }

    accessibleProjects.sort(
      (a, b) => a.project._creationTime - b.project._creationTime,
    );
    const first = accessibleProjects[0]!;
    const hasNonSampleProject = accessibleProjects.length > 1;

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", first.project._id))
      .take(50);
    const firstVersion = versions
      .slice()
      .sort((a, b) => a.versionNumber - b.versionNumber)[0];

    return {
      sample: {
        projectId: first.project._id,
        orgSlug: first.orgSlug,
        versionId: firstVersion?._id ?? null,
      },
      hasNonSampleProject,
    };
  },
});
