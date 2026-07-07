import { defineConfig, devices } from "@playwright/experimental-ct-react";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Component-test config for the trace-review UI (#267). Renders the real
 * components in Chromium with `convex/react` aliased to a fixture mock, so the
 * render + lazy-expand path is guarded deterministically without a backend/auth.
 */
export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.ct.spec.tsx",
  snapshotDir: "./playwright/__snapshots__",
  timeout: 20_000,
  use: {
    trace: "on-first-retry",
    ctViteConfig: {
      plugins: [react()],
      resolve: {
        alias: {
          "@": resolve(dir, "src"),
          "convex/react": resolve(
            dir,
            "src/routes/traces/__smoke__/convexReactMock.tsx",
          ),
        },
      },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
