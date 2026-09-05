// The generated wasm-bindgen package is created by `npm run build:wasm`.
// Keeping one module instance per worker avoids shared-memory requirements.
// @ts-ignore generated module is absent until the WASM build runs.
import init, {
  colorchecker_points_adapted,
  convert_background_profile,
  evaluate_adapted,
  render_rows_adapted,
  render_rows_adapted_srgb,
  render_rows_scaled_adapted,
  render_rows_scaled_adapted_srgb,
  set_from_acescg_srgb_adapted,
  set_profile_from_acescg_srgb_converted,
  set_from_output_srgb_adapted,
  set_profile_from_output_srgb_converted,
} from "./wasm/pkg/modcam16_color_core.js";

type RenderMessage = {
  kind: "render";
  id: number;
  profile: number;
  reflectance: number;
  width: number;
  height: number;
  yStart: number;
  yEnd: number;
  displayP3: boolean;
  temp: number;
  tint: number;
};

type EvaluateMessage = {
  kind: "evaluate";
  id: number;
  profile: number;
  reflectance: number;
  hue: number;
  saturation: number;
  temp: number;
  tint: number;
  background: number;
};

type ColorCheckerMessage = {
  kind: "colorchecker";
  id: number;
  profile: number;
  temp: number;
  tint: number;
};

type SetMessage = {
  kind: "set";
  id: number;
  profile: number;
  red: number;
  green: number;
  blue: number;
  temp: number;
  tint: number;
};

type ProfileConvertMessage = {
  kind: "profile-convert";
  id: number;
  profile: number;
  sourceProfile: number;
  reflectance: number;
  sourceHue: number;
  sourceSaturation: number;
  red: number;
  green: number;
  blue: number;
  background: number;
  temp: number;
  tint: number;
};

type CancelRenderMessage = { kind: "cancel-render"; id: number };

type Message = RenderMessage | EvaluateMessage | ColorCheckerMessage | SetMessage | ProfileConvertMessage | CancelRenderMessage;

type WorkerError = { kind: "worker-error"; id: number; operation: Message["kind"] };

let ready: Promise<void> | undefined;
let latestRenderId = -1;
let latestEvaluateId = -1;
let latestColorcheckerId = -1;
let latestSetId = -1;
let latestProfileConversionId = -1;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function ensureReady(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

function reportError(message: Message) {
  const error: WorkerError = { kind: "worker-error", id: "id" in message ? message.id : -1, operation: message.kind };
  workerScope.postMessage(error);
}

workerScope.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.kind === "cancel-render") {
    // Cancellation is deliberately independent from the other request
    // counters. A profile conversion or a preview promotion can invalidate a
    // row set before the next raster request is ready to launch.
    latestRenderId = Math.max(latestRenderId, message.id);
    return;
  }
  if (message.kind === "render") {
    latestRenderId = Math.max(latestRenderId, message.id);
  } else if (message.kind === "evaluate") {
    latestEvaluateId = Math.max(latestEvaluateId, message.id);
  } else if (message.kind === "colorchecker") {
    latestColorcheckerId = Math.max(latestColorcheckerId, message.id);
  } else if (message.kind === "set") {
    latestSetId = Math.max(latestSetId, message.id);
  } else if (message.kind === "profile-convert") {
    latestProfileConversionId = Math.max(latestProfileConversionId, message.id);
  }
  void ensureReady().then(() => {
    if (message.kind === "render") {
      // Slider input can queue several generations while a row block is
      // rendering. Skip obsolete blocks so the newest generation completes.
      if (message.id !== latestRenderId) {
        workerScope.postMessage({
          kind: "render-cancelled",
          id: message.id,
          profile: message.profile,
          width: message.width,
          height: message.height,
          yStart: message.yStart,
        });
        return;
      }
      let pixels: Uint8Array;
      if (message.width === 512 && message.height === 512) {
        pixels = (message.displayP3 ? render_rows_adapted : render_rows_adapted_srgb)(
          message.profile,
          message.reflectance,
          message.yStart,
          message.yEnd,
          message.temp,
          message.tint,
        );
      } else {
        pixels = (message.displayP3 ? render_rows_scaled_adapted : render_rows_scaled_adapted_srgb)(
          message.profile,
          message.reflectance,
          message.width,
          message.height,
          message.yStart,
          message.yEnd,
          message.temp,
          message.tint,
        );
      }
      workerScope.postMessage(
        {
          kind: "render",
          id: message.id,
          profile: message.profile,
          width: message.width,
          height: message.height,
          yStart: message.yStart,
          pixels,
        },
        [pixels.buffer as ArrayBuffer],
      );
      return;
    }
    if (message.kind === "evaluate") {
      if (message.id !== latestEvaluateId) return;
    }
    if (message.kind === "colorchecker") {
      if (message.id !== latestColorcheckerId) return;
      const points = colorchecker_points_adapted(message.profile, message.temp, message.tint);
      workerScope.postMessage({ kind: "colorchecker", id: message.id, profile: message.profile, temp: message.temp, tint: message.tint, points });
      return;
    }
    if (message.kind === "set") {
      if (message.id !== latestSetId) return;
      const values = message.profile === 3
        ? set_from_output_srgb_adapted(message.profile, message.red, message.green, message.blue, message.temp, message.tint)
        : set_from_acescg_srgb_adapted(message.profile, message.red, message.green, message.blue, message.temp, message.tint);
      workerScope.postMessage({
        kind: "set",
        id: message.id,
        profile: message.profile,
        temp: message.temp,
        tint: message.tint,
        values,
      });
      return;
    }
    if (message.kind === "profile-convert") {
      if (message.id !== latestProfileConversionId) return;
      let red = message.red;
      let green = message.green;
      let blue = message.blue;
      const source = evaluate_adapted(
        message.sourceProfile,
        message.reflectance,
        message.sourceHue,
        message.sourceSaturation,
        message.temp,
        message.tint,
        message.background,
      );
      if (source.length >= 33) {
        const retained = [source[30], source[31], source[32]];
        if (retained.every(Number.isFinite)) {
          [red, green, blue] = retained;
        }
      }
      const values = message.sourceProfile === 3
        ? set_profile_from_output_srgb_converted(
            message.profile,
            message.reflectance,
            red,
            green,
            blue,
          )
        : set_profile_from_acescg_srgb_converted(
            message.profile,
            message.reflectance,
            red,
            green,
            blue,
          );
      const background = convert_background_profile(
        message.sourceProfile,
        message.profile,
        message.background,
        message.reflectance,
        red,
        green,
        blue,
      );
      workerScope.postMessage({
        kind: "profile-convert",
        id: message.id,
        profile: message.profile,
        sourceProfile: message.sourceProfile,
        sourceReflectance: message.reflectance,
        sourceHue: message.sourceHue,
        sourceSaturation: message.sourceSaturation,
        temp: message.temp,
        tint: message.tint,
        sourceBackground: message.background,
        values,
        background: background[1],
        backgroundPreserved: background[0] > 0.5,
      });
      return;
    }
    if (message.id !== latestEvaluateId) return;
    const values = evaluate_adapted(
      message.profile,
      message.reflectance,
      message.hue,
      message.saturation,
      message.temp,
      message.tint,
      message.background,
    );
    workerScope.postMessage({
      kind: "evaluate",
      id: message.id,
      profile: message.profile,
      reflectance: message.reflectance,
      hue: message.hue,
      saturation: message.saturation,
      temp: message.temp,
      tint: message.tint,
      background: message.background,
      values,
    });
  }).catch(() => {
    reportError(message);
  });
};
