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
  assert.equal(await page.locator("#debug-panel").evaluate(panel => panel.open), false, "debug info starts folded");
  await page.locator("#debug-panel summary").click();
  await page.waitForFunction(() => /\d+ entries/.test(document.querySelector("#debug-count").textContent || ""));
  assert.match(await page.locator("#debug-output").inputValue(), /Debug capture ready/);
  assert.equal(await page.locator("#debug-output").isEditable(), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), "auto");
  const debugDownloadReady = page.waitForEvent("download");
  await page.locator("#save-debug").click();
  const debugDownload = await debugDownloadReady;
  assert.equal(debugDownload.suggestedFilename(), "decomposition-debug.txt");
  assert.match(await readFile(await debugDownload.path(), "utf8"), /Debug capture ready/);
  await page.waitForFunction(() => document.querySelector("#debug-save-status").textContent === "Debug info saved as decomposition-debug.txt.");
  await page.locator("#debug-panel summary").click();
  assert.equal(await page.locator("#debug-panel").evaluate(panel => panel.open), false);
  await page.waitForFunction(() => !document.body.classList.contains("diagnostics-open"));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), "hidden");
  assert.equal(await page.locator("#save-overlay-preview").isVisible(), false);
  assert.equal(await page.locator("#save-overlay-preview").textContent(), "Save full-size JPEG");
  assert.equal(await page.locator("#source-gamut").isVisible(), false);
  assert.equal(await page.locator("#source-transfer").isVisible(), false);
  assert.equal(await page.locator("#download-exposure span").textContent(), "Exposure EXR (norm EV)");
  assert.equal(await page.locator(".previews button").count(), 2, "thumbnails have no JPEG download buttons");
  assert.ok(!(await page.locator(".downloads").innerText()).includes("ZIP16"));
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
  assert.ok((await page.locator("#report-metrics").innerText()).includes("norm EV, scalar fp16"));
  assert.ok(!/normalized\s+EV/i.test(await page.locator("body").innerText()));
  await page.locator("#base-preview-image").evaluate(image => image.decode());
  assert.deepEqual(await page.locator("#base-preview-image").evaluate(image => [image.naturalWidth, image.naturalHeight]), [96, 64]);
  await page.locator("#base-preview-trigger").click();
  await page.locator("#preview-overlay-image").evaluate(image => image.decode());
  assert.equal(await page.locator("#preview-overlay-title").innerText(), "Base preview");
  assert.equal(await page.locator("#preview-overlay-meta").innerText(), "Display P3 · 96 × 64");
  await page.locator("#close-preview").click();
  assert.equal(await page.locator("#save-overlay-preview").isVisible(), false);
  console.log("Actual small-image decode, solve, four JPEG encoders, and result display passed.");

  // Seed large JPEG artifacts to isolate browser rendering/download behavior
  // from a 24-megapixel solve. Color/resampling correctness is tested in Rust.
  function jpeg(width, height, green = 110) {
    const row = Uint8Array.from({ length: width * 3 }, (_, i) => [Math.round(i / 3 / width * 255), green, 170][i % 3]);
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) pixels.set(row, y * row.length);
    return Buffer.from(encode_preview_pixels(pixels, width, height));
  }
  const full = { base: jpeg(6000, 4000), exposure: jpeg(6000, 4000, 170) }, display = jpeg(2048, 1365);
  await page.evaluate(async ({ full, display }) => {
    const root = await navigator.storage.getDirectory();
    const outputs = [];
    for (const component of ["base", "exposure"]) {
      for (const [suffix, data, width, height] of [["preview", full[component], 6000, 4000], ["display", display, 2048, 1365]]) {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const name = `decomposition-1-${component}-${suffix}.jpg`;
        const handle = await root.getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        await stream.write(bytes); await stream.close();
        outputs.push({ name, size: bytes.length, width, height, kind: `${component}-${suffix}-jpeg` });
      }
    }
    window.testWorkers.findLast(worker => !worker.wasTerminated).onmessage({ data: { kind: "result", id: 1, report: window.testReport, outputs, storage: "opfs" } });
  }, { full: { base: full.base.toString("base64"), exposure: full.exposure.toString("base64") }, display: display.toString("base64") });
  await page.waitForFunction(() => ["base", "exposure"].every(component => document.querySelector(`#${component}-preview-image`).naturalWidth === 2048));
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    const widths = await page.locator(".downloads button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
    assert.equal(widths.length, 3);
    assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `EXR widths differ: ${widths}`);
    for (const component of ["base", "exposure"]) {
      await page.locator(`#${component}-preview-image`).evaluate(image => image.decode());
      const bounds = await page.locator(`#${component}-preview-image`).evaluate(image => {
        const rect = image.getBoundingClientRect(), frame = image.parentElement.getBoundingClientRect();
        return { width: image.naturalWidth, height: image.naturalHeight, fits: rect.width <= frame.width && rect.height <= frame.height,
          fit: getComputedStyle(image).objectFit, background: getComputedStyle(image.parentElement).backgroundColor };
      });
      assert.deepEqual(bounds, { width: 2048, height: 1365, fits: true, fit: "contain", background: "rgb(0, 0, 0)" });
      assert.equal(await page.locator("#save-overlay-preview").isVisible(), false);
      await page.locator(`#${component}-preview-trigger`).click();
      await page.locator("#preview-overlay-image").evaluate(image => image.decode());
      assert.deepEqual(await page.locator("#preview-overlay-image").evaluate(image => [image.naturalWidth, image.naturalHeight]), [2048, 1365]);
      assert.equal(await page.locator("#preview-overlay-title").innerText(), component === "base" ? "Base preview" : "Exposure preview");
      assert.equal(await page.locator("#preview-overlay-meta").innerText(), "Display P3 · 2048 × 1365");
      assert.equal(await page.locator("#save-overlay-preview").isVisible(), true);
      const layout = await page.evaluate(() => {
        const title = document.querySelector("#preview-overlay-title"), meta = document.querySelector("#preview-overlay-meta");
        const titleRect = title.getBoundingClientRect(), metaRect = meta.getBoundingClientRect();
        const download = document.querySelector("#save-overlay-preview").getBoundingClientRect();
        const close = document.querySelector("#close-preview").getBoundingClientRect();
        const brightness = element => getComputedStyle(element).color.match(/\d+/g).slice(0, 3).reduce((a, n) => a + Number(n), 0);
        return { below: metaRect.top >= titleRect.bottom, dimmer: brightness(meta) < brightness(title),
          besideClose: Math.abs(download.top - close.top) < 1 && download.right < close.left,
          fits: titleRect.left >= 0 && metaRect.right <= innerWidth && download.left >= 0 && close.right <= innerWidth };
      });
      assert.deepEqual(layout, { below: true, dimmer: true, besideClose: true, fits: true });
      await page.screenshot({ path: `${artifacts}/${viewport.width}-${component}-overlay.png` });
      await page.locator("#preview-overlay-label").click();
      assert.equal(await page.locator("#preview-overlay").isVisible(), false);
      assert.equal(await page.locator("#save-overlay-preview").isVisible(), false);
    }
    await page.screenshot({ path: `${artifacts}/${viewport.width}-page.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  // Force the unsupported desktop path independently of host share support.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
  });
  for (const component of ["base", "exposure"]) {
    await page.locator(`#${component}-preview-trigger`).click();
    const waiting = page.waitForEvent("download");
    await page.locator("#save-overlay-preview").click();
    const download = await waiting;
    assert.ok(download.suggestedFilename().includes(`${component}-preview-display-p3.jpg`));
    assert.deepEqual(await readFile(await download.path()), full[component]);
    assert.equal(await page.locator("#preview-overlay").isVisible(), true, "download keeps the preview open");
    await page.locator("#close-preview").click();
  }
  assert.deepEqual(errors, []);
  console.log("Contain-fit thumbnails, equal EXR widths, two-line overlay labels, contextual full-size saves, and desktop/mobile bounds passed.");

  // Capture the native share boundary: verify full-size, named JPEG bytes,
  // tap activation, and cancellation without triggering a fallback download.
  let unexpectedDownloads = 0;
  const recordDownload = () => { unexpectedDownloads++; };
  page.on("download", recordDownload);
  await page.evaluate(() => {
    window.sharedFiles = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: ({ files }) => files?.length === 1 && files[0].type === "image/jpeg" });
    Object.defineProperty(navigator, "share", { configurable: true, value: data => {
      window.sharedFiles.push({ file: data.files[0], active: navigator.userActivation.isActive, keys: Object.keys(data) });
      if (window.shareFailure) return Promise.reject(new DOMException("Test share response", window.shareFailure));
      return Promise.resolve();
    } });
  });
  for (const [index, component] of ["base", "exposure"].entries()) {
    await page.locator(`#${component}-preview-trigger`).click();
    await page.locator("#save-overlay-preview").click();
    const shared = await page.evaluate(async index => {
      const { file, active, keys } = window.sharedFiles[index];
      return { name: file.name, type: file.type, active, keys, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
    }, index);
    assert.equal(shared.name, `preview-${component}-preview-display-p3.jpg`);
    assert.equal(shared.type, "image/jpeg");
    assert.equal(shared.active, true, "share called directly from the tap gesture");
    assert.deepEqual(shared.keys, ["files"], "share only the JPEG so Photos recognizes it");
    assert.deepEqual(Buffer.from(shared.bytes), full[component], "original dimensions and ICC bytes survive sharing");
    assert.equal(await page.locator("#preview-overlay").isVisible(), true);
    assert.equal(await page.locator("#save-overlay-preview").isEnabled(), true);
    await page.locator("#close-preview").click();
  }
  await page.locator("#base-preview-trigger").click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  });
  await page.locator("#save-overlay-preview").click();
  assert.equal(await page.evaluate(() => window.sharedFiles.length), 3, "share remains usable when canShare is absent");
  await page.evaluate(() => { window.shareFailure = "AbortError"; });
  await page.locator("#save-overlay-preview").click();
  assert.equal(await page.locator("#preview-save-status").isVisible(), false);
  assert.equal(await page.locator("#save-overlay-preview").isEnabled(), true);
  await page.evaluate(() => { window.shareFailure = "NotAllowedError"; });
  await page.locator("#save-overlay-preview").click();
  assert.match(await page.locator("#preview-save-status").innerText(), /Unable to open the save options/);
  assert.equal(await page.locator("#save-overlay-preview").isEnabled(), true);
  assert.equal(unexpectedDownloads, 0, "sharing, cancellation, and failures never download a file");
  await page.locator("#close-preview").click();

  // Simulate iPhone without Web Share (e.g. the HTTP LAN page). Its explicit
  // Save action opens the original JPEG; ordinary page previews remain capped.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1" });
  });
  await page.locator("#exposure-preview-trigger").click();
  const popupReady = page.waitForEvent("popup");
  await page.locator("#save-overlay-preview").click();
  const imageTab = await popupReady;
  await imageTab.waitForLoadState();
  await imageTab.locator("img").evaluate(image => image.decode());
  assert.deepEqual(await imageTab.locator("img").evaluate(image => [image.naturalWidth, image.naturalHeight]), [6000, 4000]);
  assert.equal(await imageTab.evaluate(() => window.opener === null), true);
  const openedImage = await page.evaluate(async url => {
    const response = await fetch(url);
    return { type: response.headers.get("content-type"), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, imageTab.url());
  assert.equal(openedImage.type, "image/jpeg");
  assert.deepEqual(Buffer.from(openedImage.bytes), full.exposure);
  assert.match(await page.locator("#preview-save-status").innerText(), /touch and hold.*Save to Photos/);
  assert.equal(await page.locator("#preview-overlay-image").evaluate(image => image.naturalWidth), 2048);
  assert.equal(unexpectedDownloads, 0, "iPhone fallback opens an image instead of downloading a file");
  await imageTab.close();
  await page.screenshot({ path: `${artifacts}/375-save-to-photos.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator("#close-preview").click();
  page.off("download", recordDownload);
  assert.deepEqual(errors, []);
  console.log("Full-size native JPEG sharing, cancellation, share failure, and iPhone image-tab saving passed (OS Photos sheet requires device verification).");
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
