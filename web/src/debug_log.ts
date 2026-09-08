export type DebugEntry = { time: string; source: string; level: string; message: string };
export type DebugMessage = { kind: "debug-log"; entry: DebugEntry };

const MAX_VALUE = 32_000;

// Serialize before crossing worker boundaries. Avoid cloning pixel buffers or
// invoking arbitrary getters, and preserve Error stacks that JSON drops.
export function debugText(value: unknown): string {
  const seen = new WeakSet<object>();
  function describe(item: unknown, depth: number): unknown {
    if (typeof item === "string") return item.length > MAX_VALUE ? `${item.slice(0, MAX_VALUE)}… [value truncated]` : item;
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (item instanceof Error) {
      return { name: item.name, message: describe(item.message, depth + 1), stack: describe(item.stack, depth + 1),
        ...(depth < 5 && item.cause !== undefined ? { cause: describe(item.cause, depth + 1) } : {}) };
    }
    if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return `[${item.constructor.name}: ${item.byteLength} bytes]`;
    if (typeof Blob !== "undefined" && item instanceof Blob) {
      return { type: item.type, size: item.size, ...(typeof File !== "undefined" && item instanceof File ? { name: item.name } : {}) };
    }
    if (depth >= 5) return `[${item.constructor?.name ?? "Object"}]`;
    if (Array.isArray(item)) return [...item.slice(0, 40).map(v => describe(v, depth + 1)), ...(item.length > 40 ? ["… [items truncated]"] : [])];
    const fields = Object.getOwnPropertyDescriptors(item);
    return Object.fromEntries(Object.keys(fields).slice(0, 40).map(key => [key, "value" in fields[key] ? describe(fields[key].value, depth + 1) : "[accessor]"]));
  }
  try {
    const result = typeof value === "string" ? value : JSON.stringify(describe(value, 0), null, 2);
    return result.length > MAX_VALUE ? `${result.slice(0, MAX_VALUE)}\n[entry truncated]` : result;
  } catch { return "[unserializable value]"; }
}

export function installDebugCapture(source: string, sink: (entry: DebugEntry) => void): void {
  const emit = (level: string, values: unknown[]) => {
    try { sink({ time: new Date().toISOString(), source, level, message: debugText(values.map(debugText).join(" ")) }); }
    catch { /* Diagnostics must never break the operation being observed. */ }
  };
  for (const method of ["log", "info", "debug", "warn", "error", "trace", "table", "group", "groupCollapsed"] as const) {
    const original = console[method].bind(console);
    console[method] = (...values: unknown[]) => {
      emit(method, method === "trace" ? [...values, new Error("Console trace")] : values);
      original(...values);
    };
  }
  const originalAssert = console.assert.bind(console);
  console.assert = (condition?: boolean, ...values: unknown[]) => {
    if (!condition) emit("error", ["Assertion failed", ...values, new Error("Console assertion")]);
    originalAssert(condition, ...values);
  };
  const timers = new Map<string, number>();
  const originalTime = console.time.bind(console), originalTimeLog = console.timeLog.bind(console), originalTimeEnd = console.timeEnd.bind(console);
  console.time = (label = "default") => { if (!timers.has(label) && timers.size < 100) timers.set(label, performance.now()); originalTime(label); };
  const timerMessage = (label: string) => `${label}: ${timers.has(label) ? `${(performance.now() - timers.get(label)!).toFixed(2)} ms` : "unknown timer"}`;
  console.timeLog = (label = "default", ...values: unknown[]) => { emit("info", [timerMessage(label), ...values]); originalTimeLog(label, ...values); };
  console.timeEnd = (label = "default") => { emit("info", [timerMessage(label)]); timers.delete(label); originalTimeEnd(label); };
  const events = globalThis as unknown as EventTarget;
  events.addEventListener("error", ((event: ErrorEvent) => {
    if (event.message) emit("error", ["Uncaught error", event.error ?? event.message, { message: event.message, file: event.filename, line: event.lineno, column: event.colno }]);
    else {
      const target = event.target as HTMLElement | null;
      emit("error", ["Resource failed to load", { tag: target?.tagName, url: target?.getAttribute?.("src") ?? target?.getAttribute?.("href") }]);
    }
  }) as EventListener, true);
  events.addEventListener("unhandledrejection", ((event: PromiseRejectionEvent) => emit("error", ["Unhandled promise rejection", event.reason])) as EventListener);
}

export function debugEnvironment(): object {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  return { userAgent: nav.userAgent, platform: nav.platform, language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency, deviceMemoryGiB: nav.deviceMemory,
    secureContext: isSecureContext, crossOriginIsolated: globalThis.crossOriginIsolated,
    location: `${location.origin}${location.pathname}`, webAssembly: typeof WebAssembly !== "undefined",
    webgpu: Boolean(nav.gpu), opfs: typeof nav.storage?.getDirectory === "function",
    ...(typeof window !== "undefined" ? { viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio } : {}) };
}
