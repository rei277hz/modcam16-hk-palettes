// Run against Vite with PLAYWRIGHT_MODULE pointing to an installed Playwright.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import init, { encode_preview_pixels } from "../src/wasm/decomposition/modcam16_decomposition_wasm.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.PREVIEW_ORIGIN || "http://127.0.0.1:5174";
const artifacts = process.env.PREVIEW_ARTIFACTS || "/tmp/colors-source-preview-check";
await mkdir(artifacts, { recursive: true });
await init({ module_or_path: await readFile(new URL("../src/wasm/decomposition/modcam16_decomposition_wasm_bg.wasm", import.meta.url)) });
function taggedJpeg(width, height) {
  const pixels = Uint8Array.from({ length: width * height * 3 }, (_, i) => {
    const x = Math.floor(i / 3) % width, y = Math.floor(i / 3 / width);
    return [30 + Math.round(x / width * 190), 60 + Math.round(y / height * 120), 100][i % 3];
  });
  return { name: `tagged-${width}-${height}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(encode_preview_pixels(pixels, width, height)) };
}
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", `--unsafely-treat-insecure-origin-as-secure=${origin}`] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.previewRequests = [];
    window.previewErrors = [];
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.kind === "error") window.previewErrors.push(data.message);
        });
      }
      postMessage(message, ...args) {
        if (message.kind === "inspect" && window.holdInspection) {
          window.releaseInspection = () => super.postMessage(message, ...args);
          return;
        }
        if (message.kind === "preview") window.previewRequests.push({ bytes: message.bytes?.byteLength || 0, mode: message.mode });
        if (message.kind === "calculate" && window.holdCalculation) {
          window.calculationHeld = true;
          return;
        }
        super.postMessage(message, ...args);
      }
    };
  });
  await page.goto(`${origin}/decompose.html`);
  assert.equal(await page.locator("#source-preview-empty").isVisible(), true);
  assert.equal(await page.locator("#source-preview-image").isVisible(), false);
  assert.equal(await page.locator("#source-gamut").isVisible(), false);
  assert.equal(await page.locator("#source-gamut-label").isVisible(), false);
  const initialInterpretationLayout = await page.locator(".interpretation-group").evaluate(group => {
    const gamut = group.querySelector("#source-gamut-field");
    const transfer = group.querySelector("#source-transfer-field");
    const format = group.querySelector("#source-format-indicator");
    return {
      groupHeight: group.getBoundingClientRect().height,
      gamutHeight: gamut.getBoundingClientRect().height,
      transferHeight: transfer.getBoundingClientRect().height,
      formatHeight: format.getBoundingClientRect().height,
      groupVisibility: getComputedStyle(group).visibility,
      gamutVisibility: getComputedStyle(gamut).visibility,
      transferVisibility: getComputedStyle(transfer).visibility,
      formatVisibility: getComputedStyle(format).visibility,
      gamutOrder: getComputedStyle(gamut).order,
      transferOrder: getComputedStyle(transfer).order,
      formatOrder: getComputedStyle(format).order,
    };
  });
  assert.ok(initialInterpretationLayout.groupHeight > 0);
  assert.ok(initialInterpretationLayout.gamutHeight > 0);
  assert.ok(initialInterpretationLayout.transferHeight > 0);
  assert.ok(initialInterpretationLayout.formatHeight > 0);
  assert.equal(initialInterpretationLayout.groupVisibility, "hidden");
  assert.equal(initialInterpretationLayout.gamutVisibility, "hidden");
  assert.equal(initialInterpretationLayout.transferVisibility, "hidden");
  assert.equal(initialInterpretationLayout.formatVisibility, "hidden");
  assert.equal(initialInterpretationLayout.gamutOrder, "1");
  assert.equal(initialInterpretationLayout.transferOrder, "1");
  assert.equal(initialInterpretationLayout.formatOrder, "1");
  assert.equal(await page.locator("#upload-button, #metadata-summary, #metadata-warning, #override-source").count(), 0);
  assert.equal(await page.locator("#source-format-indicator").isVisible(), false);
  assert.equal(await page.locator("#source-gamut-action").isVisible(), false);
  assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
  for (const selector of ["#source-gamut", "#source-transfer"]) {
    const choices = await page.locator(`${selector} option`).evaluateAll(options => options.map(o => [o.value, o.textContent]));
    assert.ok(choices.every(([value, text]) => value && !/^select /i.test(text)));
  }
  assert.equal(await page.locator('#source-transfer option[value="embedded"]').count(), 0);

  async function waitForPreview(previous = null) {
    await page.waitForFunction(previous => {
      const image = document.querySelector("#source-preview-image");
      const frame = document.querySelector("#source-preview-frame");
      return image.getAttribute("src") && image.src !== previous && image.complete && image.naturalWidth > 0
        && !frame.classList.contains("source-preview-loading") && !frame.classList.contains("source-preview-error");
    }, previous, { timeout: 30000 });
    assert.equal(await page.locator("#source-preview-empty").isVisible(), false);
    return page.locator("#source-preview-image").getAttribute("src");
  }
  async function change(selector, value) {
    const previous = await page.locator("#source-preview-image").getAttribute("src");
    const start = performance.now();
    await page.locator(selector).selectOption(value);
    await waitForPreview(previous);
    return performance.now() - start;
  }
  async function decompose() {
    const source = await page.locator("#source-preview-image").getAttribute("src");
    await page.locator("#calculate-button").click();
    await page.waitForFunction(() => ["Complete", "Error"].includes(document.querySelector("#progress-stage").textContent), null, { timeout: 120000 });
    assert.equal(await page.locator("#progress-stage").textContent(), "Complete", await page.locator("#processing-status").textContent());
    assert.equal(await page.locator("#source-preview-image").getAttribute("src"), source);
    assert.equal(await page.locator("#source-preview-image").isVisible(), true);
  }
  async function pixels() {
    return page.locator("#source-preview-image").evaluate(image => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    });
  }
  const landscape = taggedJpeg(96, 64);
  await page.evaluate(() => { window.holdInspection = true; });
  await page.locator("#file-input").setInputFiles(landscape);
  await page.waitForFunction(() => Boolean(window.releaseInspection));
  assert.equal(await page.locator("#source-gamut").isVisible(), false, "remain hidden during inspection");
  const inspectionInterpretationLayout = await page.locator(".interpretation-group").evaluate(group => ({
    groupHeight: group.getBoundingClientRect().height,
    groupVisibility: getComputedStyle(group).visibility,
  }));
  assert.equal(inspectionInterpretationLayout.groupHeight, initialInterpretationLayout.groupHeight);
  assert.equal(inspectionInterpretationLayout.groupVisibility, "hidden");
  await page.evaluate(() => { window.holdInspection = false; window.releaseInspection(); });
  await waitForPreview();
  assert.equal(await page.locator("#source-gamut").isVisible(), true);
  assert.equal(await page.locator("#source-gamut").inputValue(), "embedded");
  assert.equal(await page.locator("#source-format-indicator").textContent(), "JPEG");
  assert.equal(await page.locator("#source-gamut-action").isVisible(), false);
  assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
  assert.equal(await page.locator("#source-transfer").isDisabled(), true);
  const embeddedInterpretationLayout = await page.locator(".interpretation-group").evaluate(group => ({
    groupHeight: group.getBoundingClientRect().height,
    gamutRect: group.querySelector("#source-gamut").getBoundingClientRect().toJSON(),
    transferHeight: group.querySelector("#source-transfer-field").getBoundingClientRect().height,
    transferRect: group.querySelector("#source-transfer-field").getBoundingClientRect().toJSON(),
    formatHeight: group.querySelector("#source-format-indicator").getBoundingClientRect().height,
    formatRect: group.querySelector("#source-format-indicator").getBoundingClientRect().toJSON(),
    groupVisibility: getComputedStyle(group).visibility,
    transferVisibility: getComputedStyle(group.querySelector("#source-transfer-field")).visibility,
    transferOrder: getComputedStyle(group.querySelector("#source-transfer-field")).order,
    formatOrder: getComputedStyle(group.querySelector("#source-format-indicator")).order,
  }));
  assert.equal(embeddedInterpretationLayout.groupHeight, initialInterpretationLayout.groupHeight);
  assert.equal(embeddedInterpretationLayout.transferHeight, initialInterpretationLayout.transferHeight);
  assert.equal(embeddedInterpretationLayout.formatHeight, initialInterpretationLayout.formatHeight);
  assert.equal(embeddedInterpretationLayout.groupVisibility, "visible");
  assert.equal(embeddedInterpretationLayout.transferVisibility, "hidden");
  assert.equal(embeddedInterpretationLayout.formatOrder, "0");
  assert.equal(embeddedInterpretationLayout.transferOrder, "1");
  assert.ok(embeddedInterpretationLayout.formatRect.top >= embeddedInterpretationLayout.gamutRect.bottom);
  assert.ok(embeddedInterpretationLayout.transferRect.top >= embeddedInterpretationLayout.formatRect.bottom);
  await decompose();
  const embeddedPixels = await pixels();
  const afterDecomposition = await change("#source-gamut", "Rec.2020");
  assert.equal(await page.locator("#source-transfer-field").isVisible(), true);
  assert.equal(await page.locator("#source-transfer").inputValue(), "sRGB");
  assert.equal(await page.locator("#source-transfer").isEnabled(), true);
  assert.notDeepEqual(await pixels(), embeddedPixels);
  assert.ok(await page.evaluate(() => window.previewRequests.at(-1).bytes > 0), "new worker must receive retained source bytes");
  const manualPixels = await pixels();
  await change("#source-transfer", "Linear");
  assert.notDeepEqual(await pixels(), manualPixels);
  assert.equal(await page.evaluate(() => window.previewRequests.at(-1).bytes), 0, "reuse worker source cache on subsequent changes");
  await decompose();
  await change("#source-transfer", "Gamma 2.2");
  await change("#source-gamut", "embedded");
  assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
  await change("#source-gamut", "Display P3 / P3-D65");
  assert.equal(await page.locator("#source-transfer").inputValue(), "sRGB");
  console.log(`Embedded/manual decompositions retain source; re-interpretation refresh ${afterDecomposition.toFixed(0)} ms, pixels change and worker cache is restored.`);

  // Cancel during preparation, when the original worker still has the cache.
  await page.evaluate(() => { window.holdCalculation = true; });
  const beforeCancel = await page.locator("#source-preview-image").getAttribute("src");
  await page.locator("#calculate-button").click();
  await page.waitForFunction(() => window.calculationHeld);
  await page.locator("#calculate-button").click();
  assert.equal(await page.locator("#progress-stage").textContent(), "Cancelled");
  assert.equal(await page.locator("#source-preview-image").getAttribute("src"), beforeCancel);
  await change("#source-transfer", "Linear");
  assert.ok(await page.evaluate(() => window.previewRequests.at(-1).bytes > 0));
  await page.evaluate(() => { window.holdCalculation = false; });
  await decompose();

  for (const [width, height] of [[96, 64], [64, 96], [64, 64]]) {
    // Exercise the visible loaded frame as the replacement control.
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#source-preview-frame").click();
    await (await chooser).setFiles(taggedJpeg(width, height));
    await waitForPreview();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.locator("#source-preview-image").evaluate(image => {
        const rect = image.getBoundingClientRect(), frame = image.parentElement.getBoundingClientRect();
        return { dimensions: [image.naturalWidth, image.naturalHeight], fit: getComputedStyle(image).objectFit,
          background: getComputedStyle(image.parentElement).backgroundColor,
          fullFrame: Math.abs(rect.width - (frame.width - 2)) < 1 && Math.abs(rect.height - (frame.height - 2)) < 1,
          contained: rect.left >= frame.left && rect.top >= frame.top && rect.right <= frame.right && rect.bottom <= frame.bottom };
      });
      assert.deepEqual(layout, { dimensions: [width, height], fit: "contain", background: "rgb(0, 0, 0)", fullFrame: true, contained: true });
      assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
      assert.equal(await page.locator("#source-preview-empty").isVisible(), false);
      const interpretationLayout = await page.locator(".interpretation-group").evaluate(group => ({
        groupHeight: group.getBoundingClientRect().height,
        transferHeight: group.querySelector("#source-transfer-field").getBoundingClientRect().height,
        formatHeight: group.querySelector("#source-format-indicator").getBoundingClientRect().height,
      }));
      assert.ok(interpretationLayout.groupHeight > 0);
      assert.ok(interpretationLayout.transferHeight > 0);
      assert.ok(interpretationLayout.formatHeight > 0);
      const pickerLayout = await page.locator(".upload-row").evaluate(row => ({
        overflowY: getComputedStyle(row).overflowY,
        scrolls: row.scrollHeight > row.clientHeight,
      }));
      assert.equal(pickerLayout.overflowY, "visible");
      assert.equal(pickerLayout.scrolls, false, `visible overflow must not create a local scroller: ${JSON.stringify(pickerLayout)}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator("#source-preview-frame").screenshot({ path: `${artifacts}/${viewport.width}-${width}x${height}-frame.png` });
    }
  }
  // Strip ancillary chunks from a canvas PNG so browser-specific color tags
  // cannot turn this manual-mode fixture into an embedded-mode image.
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 96;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#e59339"; ctx.fillRect(0, 0, 64, 96);
    return canvas.toDataURL().split(",")[1];
  }), "base64");
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset) + 12;
    if (["IHDR", "IDAT", "IEND"].includes(png.toString("ascii", offset + 4, offset + 8))) chunks.push(png.subarray(offset, offset + length));
    offset += length;
  }
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    await page.locator("#file-input").setInputFiles({ name: "untagged.png", mimeType: "image/png", buffer: Buffer.concat(chunks) });
    await waitForPreview();
    assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
    assert.equal(await page.locator("#source-gamut-action").isVisible(), true);
    assert.equal(await page.locator("#source-gamut-label").innerText(), "Primaries (action needed)");
    assert.equal(await page.locator("#source-gamut-action").evaluate(e => getComputedStyle(e).color), "rgb(231, 211, 167)");
    assert.equal(await page.locator("#source-gamut-label").evaluate(e => getComputedStyle(e).color), "rgb(191, 203, 208)");
    assert.equal(await page.locator("#source-format-indicator").textContent(), "PNG");
    assert.equal(await page.locator("#metadata-warning").count(), 0);
    assert.equal(await page.locator("#calculate-button").isDisabled(), true);
    assert.equal(await page.locator('#source-gamut option[value="embedded"]').evaluate(option => option.disabled), true);
    await page.screenshot({ path: `${artifacts}/${viewport.width}-primaries-needed.png` });
    await change("#source-gamut", "Rec.709 / sRGB");
    assert.equal(await page.locator("#source-gamut-action").isVisible(), false);
    assert.equal((await page.locator("#source-gamut-label").innerText()).trim(), "Primaries");
    assert.equal(await page.locator("#source-transfer-field").isVisible(), true);
    assert.equal(await page.locator("#source-transfer").inputValue(), "sRGB");
    assert.equal(await page.locator("#calculate-button").isEnabled(), true);
    assert.equal(await page.locator("#source-preview-frame").evaluate(e => e.classList.contains("source-preview-muted")), false);
    assert.ok(await page.locator("#source-format-indicator").evaluate(e => e.getBoundingClientRect().top >= e.previousElementSibling.getBoundingClientRect().bottom));
    await change("#source-transfer", "Linear");
    await change("#source-gamut", "Rec.2020");
    assert.equal(await page.locator("#source-transfer").inputValue(), "Linear");
    await page.screenshot({ path: `${artifacts}/${viewport.width}-primaries-selected.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await decompose();
  // The label must follow the decoded format, not the filename or MIME type.
  await page.locator("#file-input").setInputFiles({ ...landscape, name: "actually-jpeg.png", mimeType: "image/png" });
  await waitForPreview();
  assert.equal(await page.locator("#source-format-indicator").textContent(), "JPEG");
  assert.equal(await page.locator("#source-gamut-action").isVisible(), false);
  assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
  assert.equal(await page.locator("#source-gamut").inputValue(), "embedded");
  if (process.env.DNG_FIXTURE) {
    await page.locator("#file-input").setInputFiles(process.env.DNG_FIXTURE);
    await page.waitForFunction(() => document.querySelector("#progress-stage").textContent === "Ready for confirmation", null, { timeout: 120000 });
    assert.equal(await page.locator("#source-format-indicator").textContent(), "DNG");
    assert.equal(await page.locator("#source-gamut-field").isVisible(), false);
    assert.equal(await page.locator("#source-transfer-field").isVisible(), false);
    assert.equal(await page.locator("#source-format-indicator").isVisible(), true);
  }
  assert.deepEqual(await page.evaluate(() => window.previewErrors), []);
  assert.deepEqual(errors, []);
  console.log("Cancellation recovery, replacement, hidden prompt/Transfer, placeholder-free menus, and complete-image frame bounds pass on desktop/mobile.");
  console.log("Format-only indicator, removed warning banner, Primaries action prompt, sRGB default, and transfer preservation pass on desktop/mobile.");
} finally {
  await browser.close();
}
