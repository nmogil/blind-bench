import { internalMutation } from "../_generated/server";

/**
 * Backfill projectVariables.type to "text" for pre-M21 rows. Idempotent.
 *
 *   npx convex run migrations/backfillVariableType
 */
export const backfillVariableType = internalMutation({
  args: {},
  handler: async (ctx) => {
    let patched = 0;
    let skipped = 0;

    const variables = await ctx.db.query("projectVariables").take(5000);
    for (const variable of variables) {
      if (variable.type !== undefined) {
        skipped++;
        continue;
      }
      await ctx.db.patch(variable._id, { type: "text" });
      patched++;
    }

    return { patched, skipped };
  },
});
