// Water surface simulation for the wallpaper. State (rgba16f, half res):
//   R = surface height   G = height velocity   B, A = unused
// A damped wave equation is stepped once per renderTo pass; water.ts lists
// this pass four times per frame, so `dt` receives a quarter of the frame
// delta and the CFL limit (WAVE_SPEED * dt < ~0.7 texel) holds for the
// clamped dt. Water is thin, so viscosity is far lower than the ink demo's:
// fine ripples survive and interfere instead of being smoothed away.
//
// Three disturbance sources:
//   * window rects — a bow wave along the edges facing the direction of
//     travel, for drags and tile scrolling, where TS drives the rect every
//     frame. A window also calms the water it covers, but never displaces it
//   * impulses — radial splashes for the discrete events whose motion is
//     interpolated on the Rust side and therefore invisible to per-frame rect
//     sampling: windows spawning, closing, minimizing, and workspace switches
//   * pointer — a dipole that dips ahead of the cursor and lifts behind it

uniform float time;             // seconds, same clock as impulse spawn times
uniform float dt;               // seconds per substep, clamped by water.ts
uniform vec4 window_rects[12];  // x0, y0, x1, y1 in content uv
uniform vec2 window_motion[12]; // rect velocity in content uv / second
uniform float window_weight[12];// workspace opacity: fading windows press less
uniform float window_count;
uniform vec4 pointer_state;     // x, y (content uv), velocity (uv / second)
uniform vec4 impulses[8];       // x, y (content uv), radius / height, spawn time
uniform float impulse_power[8]; // signed: < 0 plunges in, > 0 lifts out

const float WAVE_SPEED = 150.0;       // texels / second
const float WAVE_DAMPING = 1.0;       // 1 / second, baseline
// Extra damping proportional to how fast the surface is moving, saturating at
// AMPLITUDE_REF_SPEED. Violent disturbances lose their energy quickly while
// gentle ripples keep the light damping above, so the surface settles in a
// predictable time no matter how hard it was hit.
const float AMPLITUDE_DAMPING = 3.0;  // 1 / second at full amplitude
const float AMPLITUDE_REF_SPEED = 120.0;
const float HEIGHT_RELAX = 0.55;      // pulls the surface back to flat
// Just enough viscosity to keep grid-frequency shimmer (which the wave
// equation never damps on its own) from surviving as static.
const float VISCOSITY = 2.0;          // 1 / second
// Viscous diffusion of the velocity field. Unlike plain damping this bites in
// proportion to wavenumber squared, so the grid-scale speckle a big
// disturbance leaves behind dies within a few frames while long swells pass
// through it almost untouched. This is what keeps a hard hit from scattering
// into fine ripples that never converge, so lowering it much further brings
// that back; raise it to make the water thicker and calmer.
const float VELOCITY_DIFFUSION = 14.0;
// The domain edges would otherwise be perfectly reflecting walls, and the
// energy bounced back from them keeps criss-crossing the surface forever.
// A band of extra damping along the border absorbs it instead.
const float SPONGE_PX = 70.0;
const float SPONGE_DAMPING = 6.0;     // 1 / second, at the very edge
// Exponential decay only ever approaches flat. A small constant drag gives
// the tail a finite end, so the surface truly settles. Both fields need it:
// draining the velocity alone would stop the last ripples mid-shape and
// leave that shape embossed on the wallpaper, decaying but never gone.
const float STATIC_FRICTION = 6.0;
const float HEIGHT_FRICTION = 0.8;
const float IMPULSE_SECONDS = 0.12;
const float IMPULSE_STRENGTH = 300.0;
// Windows do not displace the surface. A resting one used to hold a dent
// with a rim around it, and since that is a steady state rather than a
// decaying one, no amount of damping could remove it — it just read as a
// permanent bump around every window. They only calm the water they cover
// and shed a wake when they move.
const float PRESS_STIFFNESS = 40.0;
const float PRESS_EDGE_PX = 10.0;
const float PRESS_EXTRA_DAMPING = 2.0;
// --- Wave height per source. These two are independent: raise one without
// --- touching the other to change how tall that source's waves stand.
//
// Windows: a moving one pushes the surface down along its leading edges and
// releases it along the trailing ones, like a boat hull. The impulse a
// passing edge deposits per texel integrates to roughly
// WINDOW_WAKE_STRENGTH * WAKE_EDGE_PX regardless of how fast it is dragged,
// so the strength sets wave height and the width sets the trail's spread.
const float WAKE_EDGE_PX = 60.0;
const float WINDOW_WAKE_STRENGTH = 15.0;
// Cursor: the same idea as a small dipole around the pointer, dipping ahead
// of its motion and lifting behind it.
const float POINTER_WAKE_RADIUS_PX = 26.0;
const float POINTER_WAKE_STRENGTH = 20.6;

float edge_band(float dist_px) {
    return 1.0 - smoothstep(0.0, WAKE_EDGE_PX, abs(dist_px));
}

// Height and velocity of a neighbour, from one fetch: the Laplacians of both
// fields are built from the same four taps.
vec2 sample_state(EffectContext effect, vec2 content_px) {
    vec2 clamped = clamp(
        content_px,
        vec2(0.5),
        effect.content_rect_px.zw - 0.5
    );
    return texture2D(tex, effect_texture_uv_from_content_px(effect, clamped)).rg;
}

vec4 shader_main(EffectContext effect) {
    vec2 size = max(effect.content_rect_px.zw, vec2(1.0));
    vec2 px = effect_content_px(effect);
    vec2 uv01 = px / size;

    vec4 state = texture2D(tex, effect.texture_uv);
    float h = state.r;
    float v = state.g;

    vec2 neighbor_sum =
        sample_state(effect, px + vec2(-1.0, 0.0)) +
        sample_state(effect, px + vec2(1.0, 0.0)) +
        sample_state(effect, px + vec2(0.0, -1.0)) +
        sample_state(effect, px + vec2(0.0, 1.0));
    float lap = neighbor_sum.x - 4.0 * h;

    float press = 0.0;
    float wake = 0.0;
    for (int i = 0; i < 12; i++) {
        if (float(i) >= window_count) {
            break;
        }
        float weight = window_weight[i];
        vec4 rect = window_rects[i];
        vec2 lo = rect.xy * size;
        vec2 hi = rect.zw * size;
        float span_x =
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, px.x - lo.x) *
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, hi.x - px.x);
        float span_y =
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, px.y - lo.y) *
            smoothstep(-PRESS_EDGE_PX, PRESS_EDGE_PX, hi.y - px.y);
        press = max(press, span_x * span_y * weight);

        vec2 motion_px = window_motion[i] * size;
        wake += WINDOW_WAKE_STRENGTH * weight * (
            (edge_band(px.x - lo.x) * -motion_px.x +
                edge_band(px.x - hi.x) * motion_px.x) * span_y +
            (edge_band(px.y - lo.y) * -motion_px.y +
                edge_band(px.y - hi.y) * motion_px.y) * span_x
        );
    }

    // Cursor dipole. water.ts zeroes the velocity while a window drag is in
    // flight, so drags do not double up with the window's own wake.
    vec2 pointer_vel_px = pointer_state.zw * size;
    float pointer_speed = length(pointer_vel_px);
    if (pointer_speed > 1.0) {
        vec2 to_frag = px - pointer_state.xy * size;
        float pointer_mask =
            1.0 - smoothstep(0.0, POINTER_WAKE_RADIUS_PX, length(to_frag));
        float ahead =
            dot(to_frag, pointer_vel_px / pointer_speed) /
            POINTER_WAKE_RADIUS_PX;
        wake += POINTER_WAKE_STRENGTH * pointer_mask * ahead * pointer_speed;
    }

    // Splash impulses, spread over a short window after spawn and scaled by
    // dt / window so the total energy is frame-rate independent.
    for (int i = 0; i < 8; i++) {
        vec4 impulse = impulses[i];
        float age = time - impulse.w;
        if (impulse.w <= 0.0 || age < 0.0 || age > IMPULSE_SECONDS) {
            continue;
        }
        float radius_px = impulse.z * size.y;
        float dist = length((uv01 - impulse.xy) * size);
        float hit = smoothstep(radius_px, radius_px * 0.15, dist);
        v += IMPULSE_STRENGTH * impulse_power[i] * hit * dt / IMPULSE_SECONDS;
    }

    v += WAVE_SPEED * WAVE_SPEED * lap * dt;
    v -= h * PRESS_STIFFNESS * press * dt;
    v -= wake * dt;
    // Wavenumber-selective damping: the fine ripples a large disturbance
    // scatters into are the ones that disagree most with their neighbours.
    v = mix(v, neighbor_sum.y * 0.25, min(VELOCITY_DIFFUSION * dt, 0.8));

    vec2 edge_dist_px = min(px, size - px);
    float sponge =
        1.0 - smoothstep(0.0, SPONGE_PX, min(edge_dist_px.x, edge_dist_px.y));

    float amplitude_damping =
        AMPLITUDE_DAMPING * min(abs(v) / AMPLITUDE_REF_SPEED, 1.0);
    v *= max(
        0.0,
        1.0 - (WAVE_DAMPING + amplitude_damping +
            PRESS_EXTRA_DAMPING * press + SPONGE_DAMPING * sponge) * dt
    );
    v = sign(v) * max(abs(v) - STATIC_FRICTION * dt, 0.0);

    float neighbor_avg = (lap + 4.0 * h) * 0.25;
    h = mix(h, neighbor_avg, min(VISCOSITY * dt, 0.8));
    h += v * dt;
    h *= max(0.0, 1.0 - (HEIGHT_RELAX + SPONGE_DAMPING * sponge) * dt);
    h = sign(h) * max(abs(h) - HEIGHT_FRICTION * dt, 0.0);

    return vec4(h, v, 0.0, 1.0);
}
