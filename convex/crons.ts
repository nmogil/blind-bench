import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// M30: sweep orphan guest accounts (signed in anonymously, never accepted a
// reviewer invite). See convex/anonCleanup.ts for the cascade + retention rule.
crons.daily(
  "cleanup orphan guest accounts",
  { hourUTC: 8, minuteUTC: 0 },
  internal.anonCleanup.cleanupAnonUsers,
);

export default crons;
