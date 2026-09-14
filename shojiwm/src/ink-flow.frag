// Ink surface simulation. State (rgba16f, half resolution):
//   R = surface height   G = height velocity   B = wetness   A = unused
// A damped wave equation is stepped once per renderTo pass; ink.ts lists this
// pass FOUR times per frame, so `dt` receives a quarter of the frame delta
// and the CFL stability limit (WAVE_SPEED * dt < ~0.7 texel) holds for the
// clamped dt.
// Energy sources: freshly fired splats (a short downward impulse after their
// spawn time) and window rects pressing the surface down (a moving rect
// releases its trailing edge and dips its leading edge, shedding a wake).

uniform float time;             // seconds, same clock as splat spawn times
uniform float dt;               // seconds per substep, clamped by ink.ts
uniform vec4 splats[10];        // x, y (content uv), radius / height, spawn time
uniform vec4 window_rects[12];  // x0, y0, x1, y1 in content uv
uniform vec2 window_motion[12]; // rect velocity in content uv / second
uniform float window_count;
uniform vec4 pointer_state;     // x, y (content uv), velocity (uv / second)

const float WAVE_SPEED = 150.0;       // texels / second
const float WAVE_DAMPING = 1.3;       // 1 / second
const float HEIGHT_RELAX = 0.9;       // pulls the surface back to flat
// Viscosity bleeds height detail into the neighbourhood average, killing
// grid-frequency shimmer that the wave equation itself never damps. This is
// what makes the surface read as thick ink instead of rippling water.
const float VISCOSITY = 50.0;         // 1 / second
const float SPLAT_INJECT_SECONDS = 0.14;
const float SPLAT_IMPULSE = 320.0;
const float WET_SECONDS = 6.0;        // must match ink-paint.frag
const float PRESS_DEPTH = 5.0;
const float PRESS_STIFFNESS = 55.0;
const float PRESS_EDGE_PX = 12.0;
const float PRESS_EXTRA_DAMPING = 5.0;
// Bow-wave generation: a moving window pushes the surface down along its
// leading edges and releases it along the trailing ones, like a boat hull.
// The impulse a passing edge deposits per texel integrates to roughly
// WAKE_STRENGTH * WAKE_EDGE_PX regardless of drag speed.
const float WAKE_EDGE_PX = 60.0;
const float WAKE_STRENGTH = 10.0;
// Cursor wake: a small dipole around the pointer, sharing WAKE_STRENGTH so
// window and cursor trails stay in tune when the strength is adjusted.
// POINTER_WAKE_GAIN is the cursor's relative loudness against window edges.
const float POINTER_WAKE_RADIUS_PX = 30.0;
const float POINTER_WAKE_GAIN = 10.0;

float edge_band(float dist_px) {
    return 1.0 - smoothstep(0.0, WAKE_EDGE_PX, abs(dist_px));
}

float sample_height(EffectContext effect, vec2 content_px) {
    vec2 clamped = clamp(
        content_px,
        vec2(0.5),
        effect.content_rect_px.zw - 0.5
    );
    return texture2D(tex, effect_texture_uv_from_content_px(effect, clamped)).r;
}

vec4 shader_main(EffectContext effect) {
    vec2 size = max(effect.content_rect_px.zw, vec2(1.0));
    vec2 px = effect_content_px(effect);
    vec2 uv01 = px / size;

    vec4 state = texture2D(tex, effect.texture_uv);
    float h = state.r;
    float v = state.g;
    float wet = state.b;

    float lap =
        sample_height(effect, px + vec2(-1.0, 0.0)) +
        sample_height(effect, px + vec2(1.0, 0.0)) +
        sample_height(effect, px + vec2(0.0, -1.0)) +
        sample_height(effect, px + vec2(0.0, 1.0)) -
        4.0 * h;

    float press = 0.0;
    float wake = 0.0;
    for (int i = 0; i < 12; i++) {
        if (float(i) >= window_count) {
            break;
        }
        vec4 rect = window_rects[i];
        vec2 lo = rect.xy * size;
        vec2 hi = rect.zw * size;
        float span_x =
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, px.x - lo.x) *
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, hi.x - px.x);
        float span_y =
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, px.y - lo.y) *
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, hi.y - px.y);
        press = max(press, span_x * span_y);

        // Leading edges (edge normal aligned with motion) dip the surface,
        // trailing edges lift it, so a dragged window sheds a bow wave and a
        // filling wake instead of relying on the static press alone.
        vec2 motion_px = window_motion[i] * size;
        wake +=
            (edge_band(px.x - lo.x) * -motion_px.x +
                edge_band(px.x - hi.x) * motion_px.x) * span_y +
            (edge_band(px.y - lo.y) * -motion_px.y +
                edge_band(px.y - hi.y) * motion_px.y) * span_x;
    }

    // Cursor dipole: the surface dips ahead of the pointer's motion and
    // lifts behind it, drawing the same kind of trail as a dragged window
    // edge. ink.ts zeroes the velocity while a window drag is in flight, so
    // drags do not double up with the window's own wake.
    vec2 pointer_vel_px = pointer_state.zw * size;
    float pointer_speed = length(pointer_vel_px);
    if (pointer_speed > 1.0) {
        vec2 to_frag = px - pointer_state.xy * size;
        float pointer_mask =
            1.0 - smoothstep(0.0, POINTER_WAKE_RADIUS_PX, length(to_frag));
        float ahead =
            dot(to_frag, pointer_vel_px / pointer_speed) /
            POINTER_WAKE_RADIUS_PX;
        wake += pointer_mask * ahead * pointer_speed * POINTER_WAKE_GAIN;
    }

    // Splat impulse, spread over a short window after spawn and scaled by
    // dt / window so the total energy is frame-rate independent.
    for (int i = 0; i < 10; i++) {
        vec4 splat = splats[i];
        float age = time - splat.w;
        if (splat.w <= 0.0 || age < 0.0 || age > SPLAT_INJECT_SECONDS) {
            continue;
        }
        float radius_px = splat.z * size.y;
        float dist = length((uv01 - splat.xy) * size);
        // A tight impulse: the visible ring then expands outward from the
        // impact point instead of being born blob-sized.
        float hit = smoothstep(radius_px * 0.55, radius_px * 0.1, dist);
        v -= SPLAT_IMPULSE * hit * dt / SPLAT_INJECT_SECONDS;
        wet = max(wet, smoothstep(radius_px * 1.1, radius_px * 0.5, dist));
    }

    v += WAVE_SPEED * WAVE_SPEED * lap * dt;
    v += (-PRESS_DEPTH * press - h) * PRESS_STIFFNESS * press * dt;
    v -= wake * WAKE_STRENGTH * dt;
    v *= max(0.0, 1.0 - (WAVE_DAMPING + PRESS_EXTRA_DAMPING * press) * dt);
    float neighbor_avg = (lap + 4.0 * h) * 0.25;
    h = mix(h, neighbor_avg, min(VISCOSITY * dt, 0.8));
    h += v * dt;
    h *= max(0.0, 1.0 - HEIGHT_RELAX * dt);

    wet = max(wet - dt / WET_SECONDS, 0.0);

    return vec4(h, v, wet, 1.0);
}
