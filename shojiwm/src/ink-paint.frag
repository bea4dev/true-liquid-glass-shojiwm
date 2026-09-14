// Persistent ink layer. State (rgba16f, half resolution, resize: stretch):
//   RGB = ink color (straight)   A = coverage
// Every frame each live splat re-stamps its coverage: a wobbly blob whose
// lower edge sags downward in broad lobes while the splat is wet (thick
// paint flowing under gravity), plus satellite droplets. Stamping is
// idempotent (a pure function of splat data and age) and is max()-ed into
// the persistent state, which is what makes the paint stick after the splat
// leaves the ring buffer's injection window.

uniform float time;             // seconds, same clock as splat spawn times
uniform vec4 splats[10];        // x, y (content uv), radius / height, spawn time
uniform vec3 splat_colors[10];

const float WET_SECONDS = 6.0;      // sag growth duration, matches ink-flow
const float SAG_MAX_FACTOR = 5.1;   // max sag depth in blob radii

const float HASHSCALE1 = 0.1031;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * HASHSCALE1);
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.x + p3.y) * p3.z);
}

float blob_coverage(vec2 d_px, float radius_px, float seed) {
    float ang = atan(d_px.y, d_px.x);
    float wobble = 1.0
        + 0.20 * sin(ang * 3.0 + seed * 37.0)
        + 0.12 * sin(ang * 5.0 - seed * 61.0)
        + 0.08 * sin(ang * 8.0 + seed * 113.0);
    float r = radius_px * wobble;
    return smoothstep(r, r * 0.8, length(d_px));
}

float satellite_coverage(vec2 d_px, float radius_px, float seed) {
    float cov = 0.0;
    for (int j = 0; j < 3; j++) {
        float u = hash12(vec2(seed * 101.0, float(j) * 17.0));
        float w = hash12(vec2(float(j) * 29.0, seed * 53.0));
        float ang = u * 6.2831;
        vec2 center = vec2(cos(ang), sin(ang)) * radius_px * (1.25 + 0.55 * w);
        float r = radius_px * (0.10 + 0.14 * u);
        cov = max(cov, smoothstep(r, r * 0.55, length(d_px - center)));
    }
    return cov;
}

// Broad, smooth lobes along the blob's width that decide how deep each part
// of the body sags. Low-frequency sines (radius-scale wavelengths) keep the
// sag reading as the whole ink mass flowing, never as thin runs.
float sag_lobes(float x_px, float radius_px, float seed) {
    float t = x_px / max(radius_px, 1.0);
    return 0.35
        + 0.40 * (0.5 + 0.5 * sin(t * 2.3 + seed * 19.0))
        + 0.25 * (0.5 + 0.5 * sin(t * 4.7 - seed * 31.0));
}

vec4 shader_main(EffectContext effect) {
    vec2 size = max(effect.content_rect_px.zw, vec2(1.0));
    vec2 px = effect_content_px(effect);
    vec2 uv01 = px / size;

    vec4 ink = texture2D(tex, effect.texture_uv);

    for (int i = 0; i < 10; i++) {
        vec4 splat = splats[i];
        float age = time - splat.w;
        if (splat.w <= 0.0 || age < 0.0) {
            continue;
        }
        float radius_px = splat.z * size.y;
        vec2 d_px = (uv01 - splat.xy) * size;
        float seed = fract(splat.w * 0.7309) * 7.0 + splat.x * 3.17;

        // Body sag: sample the blob SDF with the y coordinate pulled back
        // upward below the center, so the rendered lower edge stretches
        // downward by up to sag_px while the ink is wet. The ramp span is
        // wider than the max sag, which keeps the warp monotonic (no bands).
        float grow = pow(clamp(age / (WET_SECONDS * 0.8), 0.0, 1.0), 0.6);
        float sag_px = radius_px * SAG_MAX_FACTOR * grow *
            sag_lobes(d_px.x, radius_px, seed);
        float ramp = clamp(d_px.y / (radius_px * 1.4), 0.0, 1.0);
        vec2 warped = vec2(d_px.x, d_px.y - sag_px * ramp);

        float cov = blob_coverage(warped, radius_px, seed);
        cov = max(cov, satellite_coverage(d_px, radius_px, seed));

        if (cov > 0.01) {
            // Fresh ink covers old ink where its coverage dominates.
            ink.rgb = mix(ink.rgb, splat_colors[i], clamp(cov * 1.5, 0.0, 1.0));
            ink.a = max(ink.a, cov);
        }
    }

    return ink;
}
