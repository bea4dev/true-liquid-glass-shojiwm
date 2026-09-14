// Water-surface demo painted onto the wallpaper (background layer-shell
// surface). Two passes per wallpaper layer, all owned per output:
//   1. water-flow.frag x4 — damped wave equation, run as CFL substeps
//   2. water-surface.frag — water-terminal style optics over the wallpaper
//
// Disturbances reach the simulation through fixed-length uniform arrays. The
// water is meant to react to what the user sees, and what the user sees is
// not always what the config-visible state says, so rects are tracked rather
// than sampled:
//
//   * Motion TS drives itself (dragging, scroll gestures) is used directly —
//     the rect already moves once per frame, so its velocity is real.
//   * Motion the compositor interpolates (tiling layout changes, maximize,
//     workspace switches) only shows up here as the destination, arriving in
//     one step. Those are walked to their target instead, so a window ploughs
//     across the surface the way it visibly slides. Workspace switches take
//     this further: the window manager reports the slide distance, and the
//     windows coming and going ride it in and out on the same ramp that fades
//     their buoyancy.
//   * Genuine appearances and departures (spawn, close) splash.
//
// Power: the poll is the only thing running while the water moves, and it
// stops itself once the surface has settled (waves are damped, so a fixed
// settle delay is enough). External events restart it through wake(). Every
// tick marks the runtime dirty, which costs a full layer-effect
// re-evaluation, so nothing that runs during that re-evaluation may call
// wake() — see waterWallpaperEffect. Once the poll is gone the runtime
// reports no next poll at all and the compositor stops ticking the config
// entirely; dirtyWhen is false by then, so the last (flat) frame stays up.

import {
  COMPOSITOR,
  compileLayerEffect,
  computed,
  createPoll,
  dualKawaseBlur,
  get,
  layerSource,
  loadShader,
  read,
  renderTo,
  save,
  shaderStage,
  signal,
  stateSource,
  stateTexture,
  uniformArray,
  type PollHandle,
  type WaylandWindow,
} from "shoji_wm";
import type { LayerEffectHandle } from "shoji_wm/types";
import {
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
  WINDOW_STATE_WORKSPACE_VISIBLE,
} from "./window-manager";

// Array lengths are structural for uniform arrays; these must match the
// GLSL declarations in water-flow.frag.
const MAX_WINDOW_RECTS = 12;
const MAX_IMPULSES = 8;

// Every tick marks the runtime dirty, which makes the compositor re-evaluate
// all layer effects, so the tick rate is the dominant cost while the water
// moves. 16ms keeps that at display rate while still respecting the CFL
// limit: dt is split into four substeps, so WAVE_SPEED * (dt / 4) must stay
// under ~0.7 texel. Going much slower here needs more substeps.
const POLL_INTERVAL_MS = 16;
// dt is clamped so a hitch (or the poll resuming after a pause) cannot feed a
// huge step into the integrator; water-flow runs 4 substeps of dt/4 each.
const DT_MIN_S = 0.002;
const DT_MAX_S = 0.017;
// How long to keep simulating after the last disturbance. Damping puts the
// residual amplitude near a percent within this window, so freezing the
// surface at the end is invisible — and every extra second here is a second
// of runtime ticking, so it is kept as short as the damping allows.
const SETTLE_MS = 9000;
// The tail of the settle window, over which the effect fades against the bare
// wallpaper so that detaching it at the end changes nothing on screen.
const PRESENCE_FADE_MS = 2500;
// Fading back in is much quicker than fading out, but still enough that the
// tint and blur arrive rather than appear.
const PRESENCE_RISE_MS = 450;

// Velocities feeding the bow-wave term, clamped in normalized units (screens)
// per second so a teleporting rect cannot blast the sim.
const MOTION_MAX = 2.5;
const MOTION_STALE_S = 0.25;
// Cursor flicks are faster than window drags; still clamped for the sim.
const POINTER_MOTION_MAX = 3.5;
// A rect that moves further than this in a single tick did not travel: an
// animation repositioned it, and only its final target is visible from TS.
const TELEPORT_DISTANCE = 0.06;
// How long a jumped rect is walked to its target instead. window-manager
// animates window management at 0.3s and tiling/workspace moves at 0.5s;
// this sits between them, which is close enough for the water to read as
// "the window slid there" rather than "the window blinked there".
const JUMP_ANIMATION_MS = 420;
// Windows fading in or out of the surface (workspace transitions, minimize)
// gain and lose their buoyancy over this long instead of instantly.
const WEIGHT_RAMP_MS = 500;
// Windows faded below this stop pressing and leave the rect list.
const MIN_WEIGHT = 0.05;

// Splash strengths. Negative plunges the surface down, positive lifts it.
// Only real spawns and closes splash; everything else is a moving rect.
const ENTER_POWER = -1;
const EXIT_POWER = 0.75;
const DROP_POWER = -1.3;

type Vec2 = [number, number];
type Vec4 = [number, number, number, number];

const IDLE_RECT: Vec4 = [2, 2, 2, 2];
const IDLE_MOTION: Vec2 = [0, 0];
const IDLE_IMPULSE: Vec4 = [0, 0, 0, -1];
const POINTER_IDLE: Vec4 = [-10, -10, 0, 0];

/** Pipeline slot holding the wallpaper as it looks with no effect at all. */
const SHARP_WALLPAPER = "wallpaper";

// State textures are keyed by name and survive compatible hot reloads, so a
// per-load nonce makes Super+Shift+R also flatten the water.
const RESET_NONCE = Date.now().toString(36);

interface RectAnimation {
  from: Rect;
  to: Rect;
  startMs: number;
  durationMs: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TrackedWindow {
  /** Rect the simulation sees: the target, or a point along a jump. */
  rect: Rect;
  animation: RectAnimation | null;
  /** Buoyancy, ramped towards the window's workspace opacity. */
  weight: number;
  targetWeight: number;
  cx: number;
  cy: number;
  radius: number;
  atMs: number;
  /**
   * Normalized vertical displacement this window carries while it is fully
   * faded, scaled by (1 - weight). A workspace transition sets it so the
   * slide and the fade run off the same ramp; zero for everything else.
   */
  transitionShift: number;
  /** Cleared before each sweep over the tracked windows, set when found. */
  seen: boolean;
}

interface WaterInstance {
  effect: LayerEffectHandle;
  impulseData: Vec4[];
  impulsePowerData: number[];
  impulseCursor: number;
  setWindowRects: (value: Vec4[]) => void;
  setWindowMotion: (value: Vec2[]) => void;
  setWindowWeight: (value: number[]) => void;
  setWindowCount: (value: number) => void;
  setImpulses: (value: Vec4[]) => void;
  setImpulsePower: (value: number[]) => void;
  setPointer: (state: Vec4) => void;
  setActive: (value: boolean) => void;
  setPresence: (value: number) => void;
  presence: number;
  /**
   * Whether the wallpaper should be rendered through this effect at all.
   * Cleared once the water is flat, so a settled desktop pays nothing: no
   * simulation passes, no compositing pass, no state textures.
   */
  attached: boolean;
  lastRectsJson: string;
  lastActivityAtMs: number;
  // Per window id, in this output's normalized coordinates.
  windows: Map<string, TrackedWindow>;
  // Suppress splashes on the first tick, when every window is "new".
  seenFirstTick: boolean;
}

interface PointerSample {
  x: number;
  y: number;
  output: string;
  atMs: number;
}

interface PendingImpulse {
  output: string;
  x: number;
  y: number;
  radius: number;
  power: number;
}

const instances = new Map<string, WaterInstance>();
const trackedWindows = new Set<WaylandWindow>();
// Impulses carry a spawn time the shader compares against `time`. While the
// poll is stopped that clock is stale, so splashes are queued here and
// stamped on the next tick instead.
const pendingImpulses: PendingImpulse[] = [];
// Workspace slides reported by the window manager, by monitor, waiting to be
// picked up by the next tick.
const pendingTransitions = new Map<string, number>();

let clockNowMs = 0;
let poll: PollHandle | null = null;
let pollLastNowMs: number | null = null;
let wakeRequested = false;
// Ticks to keep polling after detaching, so the detach reaches the screen
// before the runtime stops being ticked at all.
const DETACH_GRACE_TICKS = 2;
let detachGraceTicks = 0;

// Latest pointer sample from index.tsx, and the sample seen by the previous
// poll tick (velocity baseline). If the pointer has not moved between polls,
// both point at the same object and the velocity naturally reads as zero.
let pointerSample: PointerSample | null = null;
let polledPointerSample: PointerSample | null = null;

const [timeSig, setTime] = signal(0);
const [dtSig, setDt] = signal(DT_MAX_S);
const substepDt = computed(() => dtSig() * 0.25);

/**
 * The wallpaper effect for an output, or null while the water is flat and the
 * effect should be off the wallpaper entirely. Called from
 * COMPOSITOR.effect.layer, which the compositor re-evaluates on every
 * runtime-dirty turn — so it must never wake the poll for an existing
 * instance, or the poll would feed itself from its own output and the water
 * could never settle. Every real disturbance wakes through its own event.
 */
export function waterWallpaperEffect(
  outputName: string,
): LayerEffectHandle | null {
  let instance = instances.get(outputName);
  if (!instance) {
    instance = createInstance(outputName);
    instances.set(outputName, instance);
    wake();
  }
  return instance.attached ? instance.effect : null;
}

export function waterTrackWindow(window: WaylandWindow) {
  trackedWindows.add(window);
  wake();
}

export function waterUntrackWindow(window: WaylandWindow) {
  trackedWindows.delete(window);
  wake();
}

/**
 * Restart the simulation poll and extend every surface's settle deadline.
 * Call it from any event that can move something on screen; the tick itself
 * decides whether there is anything to react to.
 */
export function wake() {
  wakeRequested = true;
  for (const instance of instances.values()) {
    instance.attached = true;
  }
  startPoll();
}

// Called from the pointer-move handler in index.tsx. `suppressed` is true
// while a window drag is in flight: the window's own wake covers the pointer
// then, so the cursor trail is muted to avoid doubling up.
export function waterPointerMove(
  globalX: number,
  globalY: number,
  outputName: string | undefined,
  suppressed: boolean,
) {
  if (!outputName || suppressed) {
    pointerSample = null;
    return;
  }
  pointerSample = {
    x: globalX,
    y: globalY,
    output: outputName,
    atMs: clockNowMs,
  };
  wake();
}

/**
 * A workspace is sliding in on `monitor` from `offsetY` logical pixels away
 * (the outgoing one leaves by the negative of that). The compositor
 * interpolates that slide while the config-visible rects snap straight to
 * their destination, so without this the water would only ever see windows
 * blink in and out of place.
 */
export function waterWorkspaceTransition(monitor: string, offsetY: number) {
  pendingTransitions.set(monitor, offsetY);
  wake();
}

/** Drop a stone: a manual splash at a point in global coordinates. */
export function waterDrop(
  globalX: number,
  globalY: number,
  outputName: string,
) {
  const geometry = outputGeometry(outputName);
  if (!geometry) {
    return;
  }
  queueImpulse({
    output: outputName,
    x: (globalX - geometry.x) / geometry.width,
    y: (globalY - geometry.y) / geometry.height,
    radius: 0.03 + Math.random() * 0.02,
    power: DROP_POWER,
  });
}

function createInstance(outputName: string): WaterInstance {
  const [windowRects, setWindowRects] = signal<Vec4[]>(
    Array.from({ length: MAX_WINDOW_RECTS }, () => IDLE_RECT),
  );
  const [windowMotion, setWindowMotion] = signal<Vec2[]>(
    Array.from({ length: MAX_WINDOW_RECTS }, () => IDLE_MOTION),
  );
  const [windowWeight, setWindowWeight] = signal<number[]>(
    Array.from({ length: MAX_WINDOW_RECTS }, () => 0),
  );
  const [windowCount, setWindowCount] = signal(0);
  const [impulses, setImpulses] = signal<Vec4[]>(
    Array.from({ length: MAX_IMPULSES }, () => IDLE_IMPULSE),
  );
  const [impulsePower, setImpulsePower] = signal<number[]>(
    Array.from({ length: MAX_IMPULSES }, () => 0),
  );
  // Pointer state as four component signals so the tuple can be passed as a
  // vec4 uniform directly.
  const [pointerX, setPointerX] = signal(POINTER_IDLE[0]);
  const [pointerY, setPointerY] = signal(POINTER_IDLE[1]);
  const [pointerVx, setPointerVx] = signal(POINTER_IDLE[2]);
  const [pointerVy, setPointerVy] = signal(POINTER_IDLE[3]);
  const [active, setActive] = signal(false);
  const [presence, setPresence] = signal(0);

  const flow = stateTexture(`water-flow-${RESET_NONCE}-${outputName}`, {
    scale: 0.5,
    format: "rgba16f",
    resize: "clear",
  });

  const flowStep = () =>
    renderTo(flow, {
      input: stateSource(flow),
      pipeline: [
        shaderStage(loadShader("./src/water-flow.frag"), {
          uniforms: {
            time: timeSig,
            dt: substepDt,
            window_rects: uniformArray.vec4(windowRects),
            window_motion: uniformArray.vec2(windowMotion),
            window_weight: uniformArray.float(windowWeight),
            window_count: windowCount,
            pointer_state: [pointerX, pointerY, pointerVx, pointerVy] as const,
            impulses: uniformArray.vec4(impulses),
            impulse_power: uniformArray.float(impulsePower),
          },
        }),
      ],
    });

  const effect = compileLayerEffect({
    input: layerSource(),
    invalidate: {
      kind: "manual",
      dirtyWhen: active,
      // Still repaint when the wallpaper itself changes while the water is
      // frozen, so a wallpaper swap is not held back by the idle gate.
      base: { kind: "on-source-damage-box", damagePadding: 8 },
    },
    pipeline: [
      flowStep(),
      flowStep(),
      flowStep(),
      flowStep(),
      // A touch of blur while the water is on, as if looking through it. The
      // untouched wallpaper is kept aside so the shader can cross-fade back
      // to it by presence — otherwise the blur would snap off at the moment
      // the effect detaches.
      save(SHARP_WALLPAPER),
      dualKawaseBlur({ radius: 1, passes: 1 }),
      shaderStage(loadShader("./src/water-surface.frag"), {
        textures: {
          flow: stateSource(flow),
          sharp: get(SHARP_WALLPAPER),
        },
        uniforms: {
          // emboss scales the whole shading response; refraction_px is how
          // far a wave slope can drag the wallpaper. A settled surface is
          // flat, so at rest only water_tint remains visible.
          emboss: 5,
          ripple_gain: 0.15,
          refraction_px: 14,
          reflection_gain: 1.2,
          reflection_cutoff: 0.25,
          reflection_intensity: 2.5,
          specular_strength: 0.35,
          water_tint: 0.94,
          presence,
        },
      }),
    ],
  });

  return {
    effect,
    impulseData: Array.from({ length: MAX_IMPULSES }, () => IDLE_IMPULSE),
    impulsePowerData: Array.from({ length: MAX_IMPULSES }, () => 0),
    impulseCursor: 0,
    setWindowRects,
    setWindowMotion,
    setWindowWeight,
    setWindowCount,
    setImpulses,
    setImpulsePower,
    setPointer: ([x, y, vx, vy]: Vec4) => {
      setPointerX(x);
      setPointerY(y);
      setPointerVx(vx);
      setPointerVy(vy);
    },
    setActive,
    setPresence,
    presence: 0,
    attached: true,
    lastRectsJson: "",
    lastActivityAtMs: 0,
    windows: new Map(),
    seenFirstTick: false,
  };
}

function queueImpulse(impulse: PendingImpulse) {
  if (pendingImpulses.length >= MAX_IMPULSES * 2) {
    pendingImpulses.shift();
  }
  pendingImpulses.push(impulse);
  wake();
}

function flushImpulses(nowMs: number) {
  if (pendingImpulses.length === 0) {
    return;
  }
  const spawnTime = Math.max(nowMs / 1000, 0.001);
  const touched = new Set<WaterInstance>();

  for (const pending of pendingImpulses) {
    const instance = instances.get(pending.output);
    if (!instance) {
      continue;
    }
    instance.impulseData[instance.impulseCursor] = [
      pending.x,
      pending.y,
      pending.radius,
      spawnTime,
    ];
    instance.impulsePowerData[instance.impulseCursor] = pending.power;
    instance.impulseCursor = (instance.impulseCursor + 1) % MAX_IMPULSES;
    touched.add(instance);
  }
  pendingImpulses.length = 0;

  for (const instance of touched) {
    instance.setImpulses([...instance.impulseData]);
    instance.setImpulsePower([...instance.impulsePowerData]);
    instance.lastActivityAtMs = nowMs;
    instance.setActive(true);
  }
}

function startPoll() {
  if (poll && !poll.cancelled) {
    return;
  }
  pollLastNowMs = null;
  poll = createPoll(POLL_INTERVAL_MS, tick);
}

function tick(handle: PollHandle) {
  const nowMs = handle.nowMs;
  const deltaMs =
    pollLastNowMs === null ? POLL_INTERVAL_MS : nowMs - pollLastNowMs;
  pollLastNowMs = nowMs;
  clockNowMs = nowMs;

  setTime(nowMs / 1000);
  setDt(clamp(deltaMs / 1000, DT_MIN_S, DT_MAX_S));

  if (wakeRequested) {
    wakeRequested = false;
    for (const instance of instances.values()) {
      instance.lastActivityAtMs = nowMs;
    }
  }

  updateWindowRects(nowMs, deltaMs);
  updatePointerState(nowMs);
  flushImpulses(nowMs);

  let anyActive = false;
  for (const instance of instances.values()) {
    const remainingMs = instance.lastActivityAtMs + SETTLE_MS - nowMs;
    // Falling follows the settle window exactly, so presence reaches 0 at the
    // same moment the surface is declared flat. Rising is rate limited
    // instead: re-attaching after an idle period would otherwise drop the
    // tint and the blur onto the wallpaper in a single frame.
    const target = clamp(remainingMs / PRESENCE_FADE_MS, 0, 1);
    const presence =
      target > instance.presence
        ? Math.min(target, instance.presence + deltaMs / PRESENCE_RISE_MS)
        : target;
    instance.presence = presence;
    instance.setPresence(presence);

    const active = remainingMs > 0 || presence > 0;
    instance.setActive(active);
    instance.attached = active;
    anyActive = anyActive || active;
  }

  if (anyActive || wakeRequested) {
    detachGraceTicks = 0;
    return;
  }

  // Everything has settled and every instance just asked to be detached from
  // its wallpaper. Give the compositor one more tick to re-evaluate the layer
  // effects and drop them — while the poll is alive the runtime is dirty
  // every tick, so that re-evaluation is guaranteed to happen — and only then
  // stop polling. From here a settled desktop costs nothing at all: no
  // runtime ticks, no simulation, and no effect on the wallpaper.
  if (detachGraceTicks < DETACH_GRACE_TICKS) {
    detachGraceTicks += 1;
    return;
  }
  detachGraceTicks = 0;
  handle.cancel();
  if (poll === handle) {
    poll = null;
  }
}

function updateWindowRects(nowMs: number, deltaMs: number) {
  for (const [outputName, instance] of instances) {
    const geometry = outputGeometry(outputName);
    if (!geometry) {
      continue;
    }

    for (const tracked of instance.windows.values()) {
      tracked.seen = false;
    }

    const transitionOffsetPx = pendingTransitions.get(outputName);
    pendingTransitions.delete(outputName);
    const transitionShift =
      transitionOffsetPx === undefined
        ? null
        : transitionOffsetPx / geometry.height;

    for (const window of trackedWindows) {
      const onSurface =
        !window.state[WINDOW_STATE_MINIMIZED]() &&
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE]();
      const targetWeight = onSurface
        ? clamp(window.state[WINDOW_STATE_WORKSPACE_OPACITY](), 0, 1)
        : 0;

      const rect = window.state[WINDOW_STATE_RECT]();
      // The workspace offset is a separate visual state; folding it in is
      // what makes a workspace switch move the rects at all.
      const offsetY = window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y]();
      const widthPx = read(rect.width);
      const heightPx = read(rect.height);
      const x0 = (read(rect.x) - geometry.x) / geometry.width;
      const y0 = (read(rect.y) + offsetY - geometry.y) / geometry.height;
      const target: Rect = {
        x0,
        y0,
        x1: x0 + widthPx / geometry.width,
        y1: y0 + heightPx / geometry.height,
      };
      const radius = clamp(
        (0.5 * Math.min(widthPx, heightPx)) / geometry.height,
        0.05,
        0.35,
      );

      // Windows are tracked even while off screen or fully faded, so that a
      // workspace transition — which parks them off screen at opacity 0 and
      // then jumps them into place — has a start point to animate from.
      let tracked = instance.windows.get(window.id);
      if (!tracked) {
        tracked = {
          rect: { ...target },
          animation: null,
          // Startup must not look like every window just dropped in.
          weight: instance.seenFirstTick ? 0 : targetWeight,
          targetWeight,
          cx: rectCenterX(target),
          cy: rectCenterY(target),
          radius,
          atMs: nowMs,
          transitionShift: 0,
          seen: true,
        };
        instance.windows.set(window.id, tracked);
        if (instance.seenFirstTick && targetWeight > MIN_WEIGHT) {
          queueImpulse({
            output: outputName,
            x: tracked.cx,
            y: tracked.cy,
            radius,
            power: ENTER_POWER * targetWeight,
          });
        }
        continue;
      }

      tracked.seen = true;
      tracked.targetWeight = targetWeight;
      tracked.radius = radius;

      if (transitionShift !== null) {
        const arriving =
          targetWeight > MIN_WEIGHT && tracked.weight < MIN_WEIGHT;
        const leaving = targetWeight <= MIN_WEIGHT && tracked.weight > MIN_WEIGHT;
        if (arriving) {
          // Start the slide from off screen. Placed outright rather than
          // animated: from here the weight ramp carries it in smoothly, and
          // a smooth target is what produces a bow wave.
          tracked.transitionShift = transitionShift;
          tracked.rect = shiftRect(target, transitionShift);
          tracked.animation = null;
        } else if (leaving) {
          tracked.transitionShift = -transitionShift;
        } else {
          // Not part of this transition — a window being dragged between
          // workspaces stays put and keeps its own motion.
          tracked.transitionShift = 0;
        }
      }

      advanceTrackedRect(
        tracked,
        tracked.transitionShift === 0
          ? target
          : shiftRect(target, tracked.transitionShift * (1 - tracked.weight)),
        nowMs,
      );
    }

    // Windows that stopped being tracked entirely: closed, or moved to a
    // different output. Those are real departures, so they splash — unlike a
    // workspace transition, which only fades the weight out.
    for (const [id, tracked] of instance.windows) {
      if (tracked.seen) {
        continue;
      }
      if (tracked.targetWeight > 0) {
        if (instance.seenFirstTick && tracked.weight > MIN_WEIGHT) {
          queueImpulse({
            output: outputName,
            x: tracked.cx,
            y: tracked.cy,
            radius: tracked.radius,
            power: EXIT_POWER * tracked.weight,
          });
        }
        tracked.targetWeight = 0;
      }
      // No live window to read a target from; let any flight finish.
      advanceTrackedRect(
        tracked,
        tracked.animation ? tracked.animation.to : tracked.rect,
        nowMs,
      );
      if (tracked.weight <= 0.001) {
        instance.windows.delete(id);
      }
    }

    instance.seenFirstTick = true;

    const rects: Vec4[] = [];
    const motions: Vec2[] = [];
    const weights: number[] = [];

    for (const tracked of instance.windows.values()) {
      // Ramp the buoyancy so windows fading in or out of a workspace sink in
      // and float back up instead of appearing and vanishing.
      const step = deltaMs / WEIGHT_RAMP_MS;
      tracked.weight += clamp(
        tracked.targetWeight - tracked.weight,
        -step,
        step,
      );

      if (rects.length >= MAX_WINDOW_RECTS || tracked.weight < MIN_WEIGHT) {
        continue;
      }
      const { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } = tracked.rect;
      if (rx1 <= 0 || rx0 >= 1 || ry1 <= 0 || ry0 >= 1) {
        continue;
      }

      // Velocity of the animated rect, which is what gives jumped windows a
      // real bow wave instead of a pair of splashes at the two ends.
      const cx = rectCenterX(tracked.rect);
      const cy = rectCenterY(tracked.rect);
      const deltaS = (nowMs - tracked.atMs) / 1000;
      let vx = 0;
      let vy = 0;
      if (deltaS > 0 && deltaS < MOTION_STALE_S) {
        vx = clamp((cx - tracked.cx) / deltaS, -MOTION_MAX, MOTION_MAX);
        vy = clamp((cy - tracked.cy) / deltaS, -MOTION_MAX, MOTION_MAX);
      }
      tracked.cx = cx;
      tracked.cy = cy;
      tracked.atMs = nowMs;

      rects.push([quantize(rx0), quantize(ry0), quantize(rx1), quantize(ry1)]);
      motions.push([quantizeMotion(vx), quantizeMotion(vy)]);
      weights.push(quantizeMotion(tracked.weight));
    }

    const count = rects.length;
    while (rects.length < MAX_WINDOW_RECTS) {
      rects.push(IDLE_RECT);
      motions.push(IDLE_MOTION);
      weights.push(0);
    }

    // Motions are part of the change signature so that when a drag stops,
    // one final update pushes the zeroed velocities into the sim.
    const json = JSON.stringify([rects, motions, weights]);
    if (json !== instance.lastRectsJson) {
      instance.lastRectsJson = json;
      instance.lastActivityAtMs = nowMs;
      instance.setWindowRects(rects);
      instance.setWindowMotion(motions);
      instance.setWindowWeight(weights);
      instance.setWindowCount(count);
      instance.setActive(true);
    }
  }
}

/**
 * Move a tracked rect towards its target for this tick.
 *
 * Window management, tiling and workspace transitions are interpolated on the
 * compositor side while the TS-visible rect snaps straight to its
 * destination. Sampling that would make a window teleport across the water.
 * So a jump starts an animation here instead, and the simulation follows the
 * interpolated rect — the window ploughs through the surface the same way the
 * user sees it slide. Small changes (a drag, a scroll gesture) are applied
 * directly, so anything TS already drives per frame stays free of lag.
 */
function advanceTrackedRect(tracked: TrackedWindow, target: Rect, nowMs: number) {
  // Compare against the destination while a window is already on its way, so
  // that a fast but continuous motion (kinetic scrolling) only nudges the
  // destination, while a genuinely new jump (a second workspace switch
  // mid-flight) restarts the walk from wherever the window has got to.
  const reference = tracked.animation ? tracked.animation.to : tracked.rect;
  const jumped =
    Math.abs(rectCenterX(target) - rectCenterX(reference)) >
      TELEPORT_DISTANCE ||
    Math.abs(rectCenterY(target) - rectCenterY(reference)) >
      TELEPORT_DISTANCE;

  if (jumped) {
    tracked.animation = {
      from: { ...tracked.rect },
      to: { ...target },
      startMs: nowMs,
      durationMs: JUMP_ANIMATION_MS,
    };
  } else if (tracked.animation) {
    tracked.animation.to = { ...target };
  } else {
    tracked.rect = { ...target };
    return;
  }

  const animation = tracked.animation;
  const progress = clamp(
    (nowMs - animation.startMs) / Math.max(animation.durationMs, 1),
    0,
    1,
  );
  // Strong ease-out, close to window-manager's cubicBezier(0.1, 0.9, 0.2, 1).
  const eased = 1 - Math.pow(1 - progress, 3);
  tracked.rect = {
    x0: lerp(animation.from.x0, animation.to.x0, eased),
    y0: lerp(animation.from.y0, animation.to.y0, eased),
    x1: lerp(animation.from.x1, animation.to.x1, eased),
    y1: lerp(animation.from.y1, animation.to.y1, eased),
  };
  if (progress >= 1) {
    tracked.animation = null;
  }
}

function shiftRect(rect: Rect, offsetY: number): Rect {
  return {
    x0: rect.x0,
    y0: rect.y0 + offsetY,
    x1: rect.x1,
    y1: rect.y1 + offsetY,
  };
}

function rectCenterX(rect: Rect): number {
  return (rect.x0 + rect.x1) * 0.5;
}

function rectCenterY(rect: Rect): number {
  return (rect.y0 + rect.y1) * 0.5;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
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
