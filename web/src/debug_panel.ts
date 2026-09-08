import { debugEnvironment, installDebugCapture, type DebugEntry } from "./debug_log";

const panel = document.querySelector<HTMLDetailsElement>("#debug-panel")!;
const log = document.querySelector<HTMLTextAreaElement>("#debug-output")!;
const count = document.querySelector<HTMLElement>("#debug-count")!;
const save = document.querySelector<HTMLButtonElement>("#save-debug")!;
const saveStatus = document.querySelector<HTMLElement>("#debug-save-status")!;
const entries: string[] = [];
let characters = 0, dropped = 0, pending: number | undefined;
const header = `Decomposition debug log · session ${new Date().toISOString()}\n${JSON.stringify(debugEnvironment(), null, 2)}\n`;

function contents(): string {
  return `${header}${dropped ? `\n[${dropped} older entries removed by the session log limit]\n` : ""}\n${entries.join("\n")}`;
}
function render(): void {
  pending = undefined;
  count.textContent = `${entries.length} entries${dropped ? ` · ${dropped} older omitted` : ""}`;
  // Do not replace the value while the user selects text on a phone.
  if (!panel.open || document.activeElement === log) return;
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
  log.value = contents();
  if (atEnd) log.scrollTop = log.scrollHeight;
}
export function appendDebug(entry: DebugEntry): void {
  if (!entry || typeof entry.message !== "string") return;
  const text = `[${entry.time}] [${entry.source}] ${entry.level.toUpperCase()}: ${entry.message.slice(0, 33_000)}`;
  entries.push(text);
  characters += text.length;
  while (entries.length > 1500 || characters > 1_000_000) {
    characters -= entries.shift()!.length;
    dropped++;
  }
  if (pending === undefined) pending = window.setTimeout(render, 150);
}
installDebugCapture("page", appendDebug);
console.info("Debug capture ready", debugEnvironment());

export function syncDiagnosticScroll(): void {
  const scroll = panel.open || (matchMedia("(max-width: 800px)").matches && document.querySelector(".report-expanded") !== null);
  const wasOpen = document.documentElement.classList.contains("diagnostics-open");
  document.documentElement.classList.toggle("diagnostics-open", scroll);
  document.body.classList.toggle("diagnostics-open", scroll);
  if (wasOpen && !scroll) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}
panel.addEventListener("toggle", () => { syncDiagnosticScroll(); if (panel.open) log.value = contents(); render(); });
syncDiagnosticScroll();
log.addEventListener("blur", render);
function debugFile(): File {
  return new File([contents()], "decomposition-debug.txt", { type: "text/plain" });
}

function downloadDebugFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

save.addEventListener("click", async () => {
  const text = contents();
  log.value = text;
  const file = debugFile();
  let shared = false;
  try {
    const shareData: ShareData = { files: [file], title: "Decomposition debug info" };
    const canShareFiles = typeof navigator.share === "function"
      && (!navigator.canShare || navigator.canShare(shareData));
    if (canShareFiles) {
      await navigator.share(shareData);
      shared = true;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      saveStatus.textContent = "Sharing cancelled.";
      return;
    }
    // A denied or unavailable share sheet should leave the user with a
    // directly savable file rather than losing the diagnostic log.
  }
  if (shared) {
    saveStatus.textContent = "Debug info ready to share.";
    return;
  }
  downloadDebugFile(file);
  saveStatus.textContent = "Debug info saved as decomposition-debug.txt.";
});
