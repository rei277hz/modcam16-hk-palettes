// Run against Vite with PLAYWRIGHT_MODULE pointing to an installed Playwright
// module, e.g. /tmp/colors-preview-browser/node_modules/playwright/index.mjs.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import init, { encode_preview_pixels } from "../src/wasm/decomposition/modcam16_decomposition_wasm.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.PREVIEW_ORIGIN || "http://127.0.0.1:5174";
const artifacts = process.env.PREVIEW_ARTIFACTS || "/tmp/colors-preview-check";
await mkdir(artifacts, { recursive: true });
await init({ module_or_path: await readFile(new URL("../src/wasm/decomposition/modcam16_decomposition_wasm_bg.wasm", import.meta.url)) });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", `--unsafely-treat-insecure-origin-as-secure=${origin}`] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.testWorkers = [];
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        window.testWorkers.push(this);
        this.addEventListener("message", event => {
          if (event.data.kind === "preview-encode") window.testReport = event.data.report;
        });
        if (String(args[0]).includes("preview_encoder_worker") && window.holdEncoder) {
          window.heldEncoder = this;
          this.postMessage = () => {};
        }
      }
      terminate() { this.wasTerminated = true; super.terminate(); }
    };
  });
  await page.goto(`${origin}/decompose.html`);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96; canvas.height = 64;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e59339"; context.fillRect(0, 0, 48, 64);
    context.fillStyle = "#42779d"; context.fillRect(48, 0, 48, 64);
    return canvas.toDataURL().split(",")[1];
  });
  await page.locator("#file-input").setInputFiles({ name: "preview.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => document.querySelector("#progress-stage").textContent === "Ready for confirmation");
  if (await page.locator("#source-gamut").isVisible()) {
    await page.locator("#source-gamut").selectOption("Rec.709 / sRGB");
    await page.locator("#source-transfer").selectOption("sRGB");
  }
  await page.locator("#calculate-button").click();
  await page.waitForFunction(() => ["Complete", "Error"].includes(document.querySelector("#progress-stage").textContent), null, { timeout: 120000 });
  assert.equal(await page.locator("#progress-stage").textContent(), "Complete", await page.locator("#processing-status").textContent());
  await page.locator("#base-preview-image").evaluate(image => image.decode());
  assert.deepEqual(await page.locator("#base-preview-image").evaluate(image => [image.naturalWidth, image.naturalHeight]), [96, 64]);
  console.log("Actual small-image decode, solve, four JPEG encoders, and result display passed.");

  // Seed large JPEG artifacts to isolate browser rendering/download behavior
  // from a 24-megapixel solve. Color/resampling correctness is tested in Rust.
  function jpeg(width, height) {
    const row = Uint8Array.from({ length: width * 3 }, (_, i) => [Math.round(i / 3 / width * 255), 110, 170][i % 3]);
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) pixels.set(row, y * row.length);
    return Buffer.from(encode_preview_pixels(pixels, width, height));
  }
  const full = jpeg(6000, 4000), display = jpeg(2048, 1365);
  await page.evaluate(async ({ full, display }) => {
    const root = await navigator.storage.getDirectory();
    const outputs = [];
    for (const component of ["base", "exposure"]) {
      for (const [suffix, data, width, height] of [["preview", full, 6000, 4000], ["display", display, 2048, 1365]]) {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const name = `decomposition-1-${component}-${suffix}.jpg`;
        const handle = await root.getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        await stream.write(bytes); await stream.close();
        outputs.push({ name, size: bytes.length, width, height, kind: `${component}-${suffix}-jpeg` });
      }
    }
    window.testWorkers[0].onmessage({ data: { kind: "result", id: 1, report: window.testReport, outputs, storage: "opfs" } });
  }, { full: full.toString("base64"), display: display.toString("base64") });
  await page.waitForFunction(() => document.querySelector("#base-preview-size").textContent.startsWith("6000"));
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    for (const component of ["base", "exposure"]) {
      await page.locator(`#${component}-preview-image`).evaluate(image => image.decode());
      const bounds = await page.locator(`#${component}-preview-image`).evaluate(image => {
        const rect = image.getBoundingClientRect(), frame = image.parentElement.getBoundingClientRect();
        return { width: image.naturalWidth, height: image.naturalHeight, fits: rect.width <= frame.width && rect.height <= frame.height };
      });
      assert.deepEqual(bounds, { width: 2048, height: 1365, fits: true });
      await page.locator(`#${component}-preview-trigger`).click();
      await page.locator("#preview-overlay-image").evaluate(image => image.decode());
      assert.deepEqual(await page.locator("#preview-overlay-image").evaluate(image => [image.naturalWidth, image.naturalHeight]), [2048, 1365]);
      await page.screenshot({ path: `${artifacts}/${viewport.width}-${component}-overlay.png` });
      await page.locator("#preview-overlay-label").click();
      assert.equal(await page.locator("#preview-overlay").isVisible(), false);
    }
    await page.screenshot({ path: `${artifacts}/${viewport.width}-page.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  for (const component of ["base", "exposure"]) {
    const waiting = page.waitForEvent("download");
    await page.locator(`#download-${component}-preview`).click();
    const download = await waiting;
    assert.ok(download.suggestedFilename().includes(`${component}-preview-display-p3.jpg`));
    assert.deepEqual(await readFile(await download.path()), full);
  }
  assert.deepEqual(errors, []);
  console.log("2048x1365 thumbnail/overlay bounds and exact full-size JPEG downloads passed at desktop/mobile viewport sizes.");
  await page.evaluate(() => { window.holdEncoder = true; });
  await page.locator("#calculate-button").click();
  await page.waitForFunction(() => Boolean(window.heldEncoder));
  await page.locator("#calculate-button").click();
  assert.equal(await page.evaluate(() => window.heldEncoder.wasTerminated), true);
  assert.equal(await page.locator("#progress-stage").textContent(), "Cancelled");
  assert.equal(await page.locator("#base-preview-image").getAttribute("src"), null);
  await page.evaluate(() => { window.holdEncoder = false; });
  await page.locator("#calculate-button").click();
  await page.waitForFunction(() => ["Complete", "Error"].includes(document.querySelector("#progress-stage").textContent), null, { timeout: 120000 });
  assert.equal(await page.locator("#progress-stage").textContent(), "Complete");
  assert.deepEqual(errors, []);
  console.log("Preview encoder cancellation, image URL clearing, and a subsequent complete job passed.");
} finally {
  await browser.close();
}
