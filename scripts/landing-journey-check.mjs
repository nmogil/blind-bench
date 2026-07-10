import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const host = "127.0.0.1";
const port = 4327;
const baseUrl = `http://${host}:${port}`;
const screenshotDir =
  process.env.JOURNEY_SCREENSHOT_DIR || "/tmp/blind-bench-journey";

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The dev server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Landing server did not become ready at ${baseUrl}`);
}

async function centerStep(page, index) {
  await page.locator(`[data-journey-step="${index}"]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    window.scrollTo({
      top: window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2,
      behavior: "instant",
    });
  });
  await page.waitForTimeout(500);
}

function collectPageErrors(page, errors) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
}

const server = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  [
    "--prefix",
    "landing",
    "run",
    "dev",
    "--",
    "--host",
    host,
    "--port",
    String(port),
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

let browser;
try {
  await waitForServer();
  await mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: true });

  const desktopErrors = [];
  const desktop = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  collectPageErrors(desktop, desktopErrors);
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });

  const workbench = desktop.locator("[data-journey-workbench]");
  await workbench.waitFor({ state: "visible" });
  assert.equal(
    await desktop.locator(".journey-diagram").count(),
    0,
    "legacy orbit should be removed",
  );
  assert.equal(
    await desktop.locator("[data-journey-progress]").count(),
    0,
    "legacy mobile progress bar should be removed",
  );

  for (let index = 0; index < 3; index += 1) {
    await centerStep(desktop, index);
    assert.equal(
      await workbench.getAttribute("data-active-step"),
      String(index),
    );
    assert.equal(
      await desktop
        .locator(`[data-workbench-state="${index}"]`)
        .getAttribute("aria-hidden"),
      "false",
      `desktop state ${index + 1} should be exposed`,
    );
    const visibleStateCount = await desktop
      .locator("[data-workbench-state]")
      .evaluateAll(
        (states) =>
          states.filter(
            (state) => getComputedStyle(state).visibility === "visible",
          ).length,
      );
    assert.equal(
      visibleStateCount,
      1,
      "workbench states should never visually overlap",
    );
  }

  await centerStep(desktop, 1);
  await desktop.screenshot({
    path: `${screenshotDir}/journey-desktop.png`,
    fullPage: false,
  });
  const desktopDemo = desktop.locator('[data-demo-instance="desktop"]');
  await desktopDemo.locator('[data-choice="A"]').click();
  await desktopDemo.locator('[data-choice="A"].selected').waitFor();
  await desktopDemo.locator("[data-demo-reveal]").waitFor({ state: "visible" });

  await desktop.evaluate(() => localStorage.removeItem("bb-demo-vote"));
  await desktop.reload({ waitUntil: "networkidle" });
  await centerStep(desktop, 1);
  const keyboardChoice = desktop.locator(
    '[data-demo-instance="desktop"] [data-choice="B"]',
  );
  await keyboardChoice.focus();
  await desktop.keyboard.press("Enter");
  await desktop
    .locator('[data-demo-instance="desktop"] [data-choice="B"].selected')
    .waitFor();
  await desktop.setViewportSize({ width: 390, height: 844 });
  await desktop
    .locator('[data-demo-instance="mobile"] [data-choice="A"]')
    .click();
  await desktop
    .locator('[data-demo-instance="mobile"] [data-choice="B"].selected')
    .waitFor();
  assert.deepEqual(
    desktopErrors,
    [],
    `desktop emitted errors: ${desktopErrors.join("\n")}`,
  );
  await desktop.close();

  const mobileErrors = [];
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  collectPageErrors(mobile, mobileErrors);
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "mobile journey should not overflow horizontally",
  );
  assert.equal(await mobile.locator("[data-mobile-journey-state]").count(), 3);
  await centerStep(mobile, 1);
  await mobile.screenshot({
    path: `${screenshotDir}/journey-mobile.png`,
    fullPage: false,
  });
  const mobileDemo = mobile.locator('[data-demo-instance="mobile"]');
  await mobileDemo.locator('[data-choice="A"]').click();
  await mobileDemo.locator('[data-choice="A"].selected').waitFor();
  assert.deepEqual(
    mobileErrors,
    [],
    `mobile emitted errors: ${mobileErrors.join("\n")}`,
  );
  await mobile.close();

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 768, height: 720 },
    { width: 1024, height: 720 },
    { width: 1280, height: 800 },
  ]) {
    const responsive = await browser.newPage({ viewport, colorScheme: "dark" });
    await responsive.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(
      await responsive.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      `journey should not overflow at ${viewport.width}×${viewport.height}`,
    );
    await responsive.close();
  }

  const lightErrors = [];
  const light = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  collectPageErrors(light, lightErrors);
  await light.goto(baseUrl, { waitUntil: "networkidle" });
  await centerStep(light, 1);
  assert.equal(
    await light.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "light-theme journey should not overflow",
  );
  assert.deepEqual(
    lightErrors,
    [],
    `light theme emitted errors: ${lightErrors.join("\n")}`,
  );
  await light.close();

  const blockedStorageErrors = [];
  const blockedStorage = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  collectPageErrors(blockedStorage, blockedStorageErrors);
  await blockedStorage.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "getItem", {
      configurable: true,
      value(key) {
        if (key === "bb-demo-vote") {
          throw new DOMException("Storage blocked", "SecurityError");
        }
        return originalGetItem.call(this, key);
      },
    });
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(key, value) {
        if (key === "bb-demo-vote") {
          throw new DOMException("Storage blocked", "SecurityError");
        }
        return originalSetItem.call(this, key, value);
      },
    });
  });
  await blockedStorage.goto(baseUrl, { waitUntil: "networkidle" });
  await centerStep(blockedStorage, 1);
  await blockedStorage
    .locator('[data-demo-instance="desktop"] [data-choice="A"]')
    .click();
  await blockedStorage
    .locator('[data-demo-instance="desktop"] [data-choice="A"].selected')
    .waitFor();
  assert.deepEqual(
    blockedStorageErrors,
    [],
    `blocked storage emitted errors: ${blockedStorageErrors.join("\n")}`,
  );
  await blockedStorage.close();

  const textZoom = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  await textZoom.goto(baseUrl, { waitUntil: "networkidle" });
  await textZoom.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const stateFitsStack = await textZoom
    .locator("[data-workbench-state]")
    .evaluateAll((states) => {
      const stack = states[0]?.parentElement;
      if (!stack) return false;
      const stackHeight = stack.getBoundingClientRect().height;
      return states.every((state) => state.scrollHeight <= stackHeight + 1);
    });
  assert.equal(
    stateFitsStack,
    true,
    "workbench states should grow without clipping at 200% text size",
  );
  await textZoom.close();

  const reduced = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await reduced.goto(baseUrl, { waitUntil: "networkidle" });
  const transitionDuration = await reduced
    .locator("[data-motion-surface]")
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  assert.equal(
    transitionDuration,
    "0s",
    "reduced motion should disable journey transitions",
  );
  await reduced.close();

  console.log(`Journey checks passed. Screenshots: ${screenshotDir}`);
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  await browser?.close();
  if (process.platform === "win32" || server.pid === undefined) {
    server.kill("SIGTERM");
  } else {
    process.kill(-server.pid, "SIGTERM");
  }
}
