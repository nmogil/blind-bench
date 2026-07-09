import { pathToFileURL } from "node:url";
import { runCanonicalDemoReadiness } from "../src/lib/evals/canonicalReadiness";

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCanonicalDemoReadiness()
    .then((report) => {
      process.stdout.write(
        `Wrote artifacts/canonical-demo-readiness.{md,json} — status: ${report.status}.\n`,
      );
      process.exit(report.status === "pass" ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`canonical-demo-readiness failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
