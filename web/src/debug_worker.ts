import { debugEnvironment, installDebugCapture } from "./debug_log";

const instance = `${globalThis.location?.pathname?.split("/").pop() ?? "worker"}@${Math.round(performance.timeOrigin)}`;
installDebugCapture(instance, entry => postMessage({ kind: "debug-log", entry }));
console.info("Worker started", debugEnvironment());

let memory: WebAssembly.Memory | undefined;
export function setDebugMemory(value: WebAssembly.Memory): void { memory = value; }
export function checkpoint(stage: string, context: object = {}): void {
  console.info(stage, { ...context, wasmMemoryBytes: memory?.buffer.byteLength });
}
