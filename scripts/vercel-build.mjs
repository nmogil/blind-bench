/* Vercel build entrypoint: real Convex deploy when a deploy key exists
 * (production — or preview, if a Convex Pro preview key is added later);
 * otherwise typecheck-only against generated stubs so PR builds still run
 * both type gates. See docs/preview-typecheck-builds.md. */
import { execSync } from "node:child_process";

const run = (cmd) => {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.error(`\nBuild step failed: ${cmd}`);
    process.exit(1);
  }
};

if (process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_SELF_HOSTED_URL) {
  run("npx convex deploy");
} else {
  console.log("No CONVEX_DEPLOY_KEY — preview typecheck build (no backend push).");
  run("node scripts/generate-convex-stubs.mjs");
  // Gate 1: what `convex deploy` would have typechecked.
  run("npx tsc -p convex --pretty false");
}
// Gate 2 + bundle: same for both paths.
run("npx tsc -b");
run("npx vite build");
