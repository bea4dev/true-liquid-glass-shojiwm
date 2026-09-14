// Splatoon-style ink demo painted onto the wallpaper (background layer-shell
// surface). Three passes per wallpaper layer, all owned per output:
//   1. ink-flow.frag  x2  — damped wave equation (ripples + window wakes),
//                           run twice per frame as CFL substeps
//   2. ink-paint.frag     — persistent ink coverage: blob + droplets + drips
//   3. ink-compose.frag   — glossy shading over the wallpaper
// Splats are injected through fixed-length uniform arrays (a ring buffer of
// signals); window rects are polled and fed the same way so moving windows
// press the ink surface and leave a wake. The whole simulation is gated by a
// manual dirtyWhen signal that turns off a few seconds after the last splat
// or window movement — the persistent state then freezes as "dried" ink.

import {
  COMPOSITOR,
  compileLayerEffect,
  computed,
  createPoll,
  layerSource,
  loadShader,
  read,
  renderTo,
  shaderStage,
  signal,
  stateSource,
  stateTexture,
  uniformArray,
  type WaylandWindow,
} from "shoji_wm";
import type { LayerEffectHandle } from "shoji_wm/types";
import {
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
} from "./window-manager";

// Array lengths are structural for uniform arrays; these must match the
// GLSL declarations in ink-flow.frag / ink-paint.frag.
const MAX_SPLATS = 10;
const MAX_WINDOW_RECTS = 12;

const POLL_INTERVAL_MS = 8;
// dt is clamped so a hitch (or dirtyWhen resuming after a pause) cannot feed
// a huge step into the integrator; ink-flow runs 4 substeps of dt/4 each,
// which is what lets WAVE_SPEED sit at 150 texels/s within the CFL limit.
const DT_MIN_S = 0.002;
const DT_MAX_S = 0.017;
// Keep simulating this long after the last splat / window movement so waves
// can settle before the effect stops re-rendering.
const ACTIVITY_IDLE_MS = 6000;

type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

const IDLE_SPLAT: Vec4 = [0, 0, 0, -1];
const IDLE_RECT: Vec4 = [2, 2, 2, 2];
const IDLE_MOTION: Vec2 = [0, 0];
const IDLE_COLOR: Vec3 = [1, 1, 1];

// Window velocities feeding the bow-wave term, clamped in normalized
// units (screens) per second so a teleporting rect cannot blast the sim.
const MOTION_MAX = 2.5;
const MOTION_STALE_S = 0.25;
// Cursor flicks are faster than window drags; still clamped for the sim.
const POINTER_MOTION_MAX = 3.5;
const POINTER_IDLE: Vec4 = [-10, -10, 0, 0];

// Splatoon 1 default match colors. Super+Shift+I toggles which team fires.
const INK_PALETTE: Vec3[] = [
  [0.95, 0.36, 0.1], // orange
  [0.16, 0.23, 0.8], // blue
];

// State textures are keyed by name and survive compatible hot reloads, so a
// per-load nonce makes Super+Shift+R double as the ink reset button.
const RESET_NONCE = Date.now().toString(36);

interface InkInstance {
  effect: LayerEffectHandle;
  splatData: Vec4[];
  colorData: Vec3[];
  splatCursor: number;
  setSplats: (value: Vec4[]) => void;
  setColors: (value: Vec3[]) => void;
  setWindowRects: (value: Vec4[]) => void;
  setWindowMotion: (value: Vec2[]) => void;
  setWindowCount: (value: number) => void;
  setPointer: (state: Vec4) => void;
  setActive: (value: boolean) => void;
  lastRectsJson: string;
  lastActivityAtMs: number;
  // Per window id: last raw (unquantized) rect center for velocity sampling.
  prevWindowCenters: Map<string, { cx: number; cy: number; atMs: number }>;
}

const instances = new Map<string, InkInstance>();
const trackedWindows = new Set<WaylandWindow>();

let paletteCursor = 0;
let clockNowMs = 0;

interface PointerSample {
  x: number;
  y: number;
  output: string;
  atMs: number;
}
// Latest pointer sample from index.tsx, and the sample seen by the previous
// poll tick (velocity baseline). If the pointer has not moved between polls,
// both point at the same object and the velocity naturally reads as zero.
let pointerSample: PointerSample | null = null;
let polledPointerSample: PointerSample | null = null;
let pollStarted = false;

const [timeSig, setTime] = signal(0);
const [dtSig, setDt] = signal(DT_MAX_S);
const substepDt = computed(() => dtSig() * 0.25);

export function inkWallpaperEffect(outputName: string): LayerEffectHandle {
  let instance = instances.get(outputName);
  if (!instance) {
    instance = createInstance(outputName);
    instances.set(outputName, instance);
    ensurePoll();
  }
  return instance.effect;
}

export function inkTrackWindow(window: WaylandWindow) {
  trackedWindows.add(window);
}

export function inkUntrackWindow(window: WaylandWindow) {
  trackedWindows.delete(window);
}

export function toggleInkColor() {
  paletteCursor = (paletteCursor + 1) % INK_PALETTE.length;
}

// Called from the pointer-move handler in index.tsx. `suppressed` is true
// while a window drag is in flight: the window's own wake covers the pointer
// then, so the cursor trail is muted to avoid doubling up.
export function inkPointerMove(
  globalX: number,
  globalY: number,
  outputName: string | undefined,
  suppressed: boolean,
) {
  if (!outputName || suppressed) {
    pointerSample = null;
    return;
  }
  pointerSample = { x: globalX, y: globalY, output: outputName, atMs: clockNowMs };
}

export function fireInkSplat(
  globalX: number,
  globalY: number,
  outputName: string,
) {
  const instance = instances.get(outputName);
  const geometry = outputGeometry(outputName);
  if (!instance || !geometry) {
    return;
  }

  const splat: Vec4 = [
    (globalX - geometry.x) / geometry.width,
    (globalY - geometry.y) / geometry.height,
    0.045 + Math.random() * 0.05, // radius as a fraction of output height
    Math.max(read(timeSig), 0.001),
  ];
  instance.splatData[instance.splatCursor] = splat;
  instance.colorData[instance.splatCursor] = INK_PALETTE[paletteCursor];
  instance.splatCursor = (instance.splatCursor + 1) % MAX_SPLATS;

  instance.setSplats([...instance.splatData]);
  instance.setColors([...instance.colorData]);
  instance.lastActivityAtMs = clockNowMs;
  instance.setActive(true);
}

function createInstance(outputName: string): InkInstance {
  const [splats, setSplats] = signal<Vec4[]>(
    Array.from({ length: MAX_SPLATS }, () => IDLE_SPLAT),
  );
  const [colors, setColors] = signal<Vec3[]>(
    Array.from({ length: MAX_SPLATS }, () => IDLE_COLOR),
  );
  const [windowRects, setWindowRects] = signal<Vec4[]>(
    Array.from({ length: MAX_WINDOW_RECTS }, () => IDLE_RECT),
  );
  const [windowMotion, setWindowMotion] = signal<Vec2[]>(
    Array.from({ length: MAX_WINDOW_RECTS }, () => IDLE_MOTION),
  );
  const [windowCount, setWindowCount] = signal(0);
  // Pointer state as four component signals so the tuple can be passed as a
  // vec4 uniform directly.
  const [pointerX, setPointerX] = signal(POINTER_IDLE[0]);
  const [pointerY, setPointerY] = signal(POINTER_IDLE[1]);
  const [pointerVx, setPointerVx] = signal(POINTER_IDLE[2]);
  const [pointerVy, setPointerVy] = signal(POINTER_IDLE[3]);
  const [active, setActive] = signal(false);

  const flow = stateTexture(`ink-flow-${RESET_NONCE}-${outputName}`, {
    scale: 0.5,
    format: "rgba16f",
    resize: "clear",
  });
  const paint = stateTexture(`ink-paint-${RESET_NONCE}-${outputName}`, {
    scale: 0.5,
    format: "rgba16f",
    resize: "stretch",
  });

  const flowStep = () =>
    renderTo(flow, {
      input: stateSource(flow),
      pipeline: [
        shaderStage(loadShader("./src/ink-flow.frag"), {
          uniforms: {
            time: timeSig,
            dt: substepDt,
            splats: uniformArray.vec4(splats),
            window_rects: uniformArray.vec4(windowRects),
            window_motion: uniformArray.vec2(windowMotion),
            window_count: windowCount,
            pointer_state: [pointerX, pointerY, pointerVx, pointerVy] as const,
          },
        }),
      ],
    });

  const effect = compileLayerEffect({
    input: layerSource(),
    invalidate: { kind: "manual", dirtyWhen: active },
    pipeline: [
      flowStep(),
      flowStep(),
      flowStep(),
      flowStep(),
      renderTo(paint, {
        input: stateSource(paint),
        pipeline: [
          shaderStage(loadShader("./src/ink-paint.frag"), {
            uniforms: {
              time: timeSig,
              splats: uniformArray.vec4(splats),
              splat_colors: uniformArray.vec3(colors),
            },
          }),
        ],
      }),
      shaderStage(loadShader("./src/ink-compose.frag"), {
        textures: {
          ink: stateSource(paint),
          flow: stateSource(flow),
        },
      }),
    ],
  });

  return {
    effect,
    splatData: Array.from({ length: MAX_SPLATS }, () => IDLE_SPLAT),
    colorData: Array.from({ length: MAX_SPLATS }, () => IDLE_COLOR),
    splatCursor: 0,
    setSplats,
    setColors,
    setWindowRects,
    setWindowMotion,
    setWindowCount,
    setPointer: ([x, y, vx, vy]: Vec4) => {
      setPointerX(x);
      setPointerY(y);
      setPointerVx(vx);
      setPointerVy(vy);
    },
    setActive,
    lastRectsJson: "",
    lastActivityAtMs: 0,
    prevWindowCenters: new Map(),
  };
}

function ensurePoll() {
  if (pollStarted) {
    return;
  }
  pollStarted = true;

  let lastNowMs: number | null = null;
  createPoll(POLL_INTERVAL_MS, (handle) => {
    const nowMs = handle.nowMs;
    const deltaMs = lastNowMs === null ? POLL_INTERVAL_MS : nowMs - lastNowMs;
    lastNowMs = nowMs;
    clockNowMs = nowMs;

    setTime(nowMs / 1000);
    setDt(clamp(deltaMs / 1000, DT_MIN_S, DT_MAX_S));

    updateWindowRects(nowMs);
    updatePointerState(nowMs);
    for (const instance of instances.values()) {
      instance.setActive(
        nowMs - instance.lastActivityAtMs < ACTIVITY_IDLE_MS,
      );
    }
  });
}

function updateWindowRects(nowMs: number) {
  for (const [outputName, instance] of instances) {
    const geometry = outputGeometry(outputName);
    if (!geometry) {
      continue;
    }

    const rects: Vec4[] = [];
    const motions: Vec2[] = [];
    const seenIds = new Set<string>();
    for (const window of trackedWindows) {
      if (rects.length >= MAX_WINDOW_RECTS) {
        break;
      }
      if (window.state[WINDOW_STATE_MINIMIZED]()) {
        continue;
      }
      if (!window.state[WINDOW_STATE_WORKSPACE_VISIBLE]()) {
        continue;
      }
      const rect = window.state[WINDOW_STATE_RECT]();
      const x0 = (read(rect.x) - geometry.x) / geometry.width;
      const y0 = (read(rect.y) - geometry.y) / geometry.height;
      const x1 = x0 + read(rect.width) / geometry.width;
      const y1 = y0 + read(rect.height) / geometry.height;
      if (x1 <= 0 || x0 >= 1 || y1 <= 0 || y0 >= 1) {
        continue;
      }
      rects.push([quantize(x0), quantize(y0), quantize(x1), quantize(y1)]);

      // Rect velocity for the bow-wave term, matched by window id so list
      // order changes cannot cross-wire velocities between windows. Raw
      // (unquantized) centers keep the estimate free of rounding jitter.
      const cx = (x0 + x1) * 0.5;
      const cy = (y0 + y1) * 0.5;
      const previous = instance.prevWindowCenters.get(window.id);
      let vx = 0;
      let vy = 0;
      if (previous) {
        const deltaS = (nowMs - previous.atMs) / 1000;
        if (deltaS > 0 && deltaS < MOTION_STALE_S) {
          vx = clamp((cx - previous.cx) / deltaS, -MOTION_MAX, MOTION_MAX);
          vy = clamp((cy - previous.cy) / deltaS, -MOTION_MAX, MOTION_MAX);
        }
      }
      motions.push([quantizeMotion(vx), quantizeMotion(vy)]);
      instance.prevWindowCenters.set(window.id, { cx, cy, atMs: nowMs });
      seenIds.add(window.id);
    }

    for (const id of instance.prevWindowCenters.keys()) {
      if (!seenIds.has(id)) {
        instance.prevWindowCenters.delete(id);
      }
    }

    const count = rects.length;
    while (rects.length < MAX_WINDOW_RECTS) {
      rects.push(IDLE_RECT);
      motions.push(IDLE_MOTION);
    }

    // Motions are part of the change signature so that when a drag stops,
    // one final update pushes the zeroed velocities into the sim.
    const json = JSON.stringify([rects, motions]);
    if (json !== instance.lastRectsJson) {
      instance.lastRectsJson = json;
      instance.lastActivityAtMs = nowMs;
      instance.setWindowRects(rects);
      instance.setWindowMotion(motions);
      instance.setWindowCount(count);
      instance.setActive(true);
    }
  }
}

function updatePointerState(nowMs: number) {
  const sample = pointerSample;
  const previous = polledPointerSample;
  polledPointerSample = sample;

  for (const [outputName, instance] of instances) {
    if (!sample || sample.output !== outputName) {
      instance.setPointer(POINTER_IDLE);
      continue;
    }
    const geometry = outputGeometry(outputName);
    if (!geometry) {
      instance.setPointer(POINTER_IDLE);
      continue;
    }

    const nx = (sample.x - geometry.x) / geometry.width;
    const ny = (sample.y - geometry.y) / geometry.height;
    let vx = 0;
    let vy = 0;
    if (previous && previous !== sample && previous.output === sample.output) {
      const deltaS = (sample.atMs - previous.atMs) / 1000;
      if (deltaS > 0 && deltaS < MOTION_STALE_S) {
        vx = clamp(
          (sample.x - previous.x) / geometry.width / deltaS,
          -POINTER_MOTION_MAX,
          POINTER_MOTION_MAX,
        );
        vy = clamp(
          (sample.y - previous.y) / geometry.height / deltaS,
          -POINTER_MOTION_MAX,
          POINTER_MOTION_MAX,
        );
      }
    }
    instance.setPointer([nx, ny, quantizeMotion(vx), quantizeMotion(vy)]);

    if (Math.abs(vx) + Math.abs(vy) > 0.02) {
      instance.lastActivityAtMs = nowMs;
      instance.setActive(true);
    }
  }
}

function outputGeometry(
  outputName: string,
): { x: number; y: number; width: number; height: number } | null {
  const output = COMPOSITOR.output.get(outputName);
  if (!output || !output.resolution) {
    return null;
  }
  return {
    x: output.position.x,
    y: output.position.y,
    width: output.resolution.width / output.scale,
    height: output.resolution.height / output.scale,
  };
}

// Sub-pixel rect jitter should not count as movement; ~half-logical-pixel
// quantization keeps idle windows from keeping the simulation awake.
function quantize(value: number): number {
  return Math.round(value * 4096) / 4096;
}

function quantizeMotion(value: number): number {
  return Math.round(value * 50) / 50;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
