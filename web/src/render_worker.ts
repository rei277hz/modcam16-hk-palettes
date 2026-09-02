// The generated wasm-bindgen package is created by `npm run build:wasm`.
// Keeping one module instance per worker avoids shared-memory requirements.
// @ts-ignore generated module is absent until the WASM build runs.
import init, {
  colorchecker_points,
  convert_background_profile,
  evaluate,
  render_rows,
  render_rows_srgb,
  render_rows_scaled,
  render_rows_scaled_srgb,
  set_from_acescg_srgb,
  set_profile_from_acescg_srgb_converted,
  set_from_output_srgb,
  set_profile_from_output_srgb,
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
};

type EvaluateMessage = {
  kind: "evaluate";
  id: number;
  profile: number;
  reflectance: number;
  hue: number;
  saturation: number;
};

type ColorCheckerMessage = {
  kind: "colorchecker";
  id: number;
  profile: number;
};

type SetMessage = {
  kind: "set";
  id: number;
  profile: number;
  red: number;
  green: number;
  blue: number;
};

type ProfileConvertMessage = {
  kind: "profile-convert";
  id: number;
  profile: number;
  sourceProfile: number;
  reflectance: number;
  red: number;
  green: number;
  blue: number;
  background: number;
};

type Message = RenderMessage | EvaluateMessage | ColorCheckerMessage | SetMessage | ProfileConvertMessage;

let ready: Promise<void> | undefined;
let latestRenderId = -1;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function ensureReady(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

workerScope.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.kind === "render") {
    latestRenderId = Math.max(latestRenderId, message.id);
  }
  void ensureReady().then(() => {
    if (message.kind === "render") {
      // Slider input can queue several generations while a row block is
      // rendering. Skip obsolete blocks so the newest generation completes.
      if (message.id !== latestRenderId) return;
      let pixels: Uint8Array;
      if (message.width === 512 && message.height === 512) {
        pixels = (message.displayP3 ? render_rows : render_rows_srgb)(
          message.profile,
          message.reflectance,
          message.yStart,
          message.yEnd,
        );
      } else {
        pixels = (message.displayP3 ? render_rows_scaled : render_rows_scaled_srgb)(
          message.profile,
          message.reflectance,
          message.width,
          message.height,
          message.yStart,
          message.yEnd,
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
    if (message.kind === "colorchecker") {
      const points = colorchecker_points(message.profile);
      workerScope.postMessage({ kind: "colorchecker", id: message.id, profile: message.profile, points });
      return;
    }
    if (message.kind === "set") {
      const values = message.profile === 3
        ? set_from_output_srgb(message.profile, message.red, message.green, message.blue)
        : set_from_acescg_srgb(message.profile, message.red, message.green, message.blue);
      workerScope.postMessage({ kind: "set", id: message.id, profile: message.profile, values });
      return;
    }
    if (message.kind === "profile-convert") {
      const values = message.sourceProfile === 3
        ? set_profile_from_output_srgb_converted(
            message.profile,
            message.reflectance,
            message.red,
            message.green,
            message.blue,
          )
        : set_profile_from_acescg_srgb_converted(
            message.profile,
            message.reflectance,
            message.red,
            message.green,
            message.blue,
          );
      const background = convert_background_profile(
        message.sourceProfile,
        message.profile,
        message.background,
        message.reflectance,
        message.red,
        message.green,
        message.blue,
      );
      workerScope.postMessage({
        kind: "profile-convert",
        id: message.id,
        profile: message.profile,
        values,
        background: background[1],
        backgroundPreserved: background[0] > 0.5,
      });
      return;
    }
    const values = evaluate(message.profile, message.reflectance, message.hue, message.saturation);
    workerScope.postMessage({ kind: "evaluate", id: message.id, profile: message.profile, values });
  });
};
