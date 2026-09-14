// Frozen-glass backdrop, shared by every blurred region (window backgrounds,
// layer-shell surfaces, popups). The blurred backdrop is refracted through a
// crystalline voronoi lattice (each facet bends light in its own fixed
// direction), with bright crack seams along cell borders, frost creeping in
// from the edges and a cool tint. All coordinates are derived from pixels,
// so the ice keeps the same physical scale no matter how large or small the
// surface is. Intentionally has no time uniform: the ice is still, so the
// stage only re-renders on backdrop damage.

uniform float crystal_px;          // approximate crystal cell size in px
uniform float refraction_px;       // max light bend per facet in px
uniform float crack_width;         // seam width in voronoi F2-F1 units
uniform float crack_intensity;     // brightness of crack seams
uniform float frost_amount;        // overall frost coverage
uniform float frost_scale;         // vein-field frequency (relative to crystals)
uniform float edge_frost;          // extra frost creeping from the borders
uniform float edge_frost_px;       // creep depth of the border frost in px
uniform float ice_tint;            // 0..1 cool blue grading
uniform float ice_opacity;         // 0 = clear glass, 1 = fully frozen

const float HASHSCALE1 = 0.1031;
const vec3 HASHSCALE3 = vec3(0.1031, 0.1030, 0.0973);

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * HASHSCALE1);
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * HASHSCALE3);
    p3 += dot(p3, p3.yzx + 19.19);
    return fract((p3.xx + p3.yz) * p3.zy);
}

float value_noise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(cell);
    float b = hash12(cell + vec2(1.0, 0.0));
    float c = hash12(cell + vec2(0.0, 1.0));
    float d = hash12(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Ridged noise: folds value noise around its midpoint so the bright maxima
// form thin connected veins, which is what frost dendrites look like.
float ridge(vec2 p) {
    return 1.0 - abs(2.0 * value_noise(p) - 1.0);
}

float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
        sum += value_noise(p) * amp;
        p = p * 2.17 + vec2(11.31, 7.77);
        amp *= 0.5;
    }
    return sum;
}

// xy = (F1, F2) distances, zw = the winning cell id for facet seeding.
vec4 voronoi(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    vec2 facet_seed = vec2(0.0);

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec2 site = offset + hash22(cell + offset) - f;
            float d = dot(site, site);
            if (d < f1) {
                f2 = f1;
                f1 = d;
                facet_seed = cell + offset;
            } else if (d < f2) {
                f2 = d;
            }
        }
    }

    return vec4(sqrt(f1), sqrt(f2), facet_seed);
}

vec4 shader_main(EffectContext effect) {
    vec2 rect_size = effect.content_rect_px.zw;
    vec2 safe_size = max(rect_size, vec2(1.0));
    vec2 frag = effect_content_px(effect);
    vec2 ice_uv = frag / max(crystal_px, 1.0);

    vec4 crystal = voronoi(ice_uv);
    float seam_dist = crystal.y - crystal.x;
    float seam_width = max(crack_width, 0.001);
    float crack = 1.0 - smoothstep(0.0, seam_width, seam_dist);
    float crack_glow = 1.0 - smoothstep(0.0, seam_width * 5.0, seam_dist);

    // Each crystal facet bends the light in its own fixed direction; a gentle
    // fbm gradient on top keeps the facets from looking optically flat. The
    // bend is expressed in pixels and converted to uv per axis, so the
    // distortion depth is surface-size independent.
    vec2 facet_dir = hash22(crystal.zw) * 2.0 - 1.0;
    float bump = 0.035;
    float height = fbm(ice_uv * 1.7);
    vec2 surface_grad = vec2(
        fbm(ice_uv * 1.7 + vec2(bump, 0.0)) - height,
        fbm(ice_uv * 1.7 + vec2(0.0, bump)) - height
    ) / bump;
    vec2 bend = facet_dir * 0.6 + surface_grad * 0.4;
    vec2 sample_px = frag +
        bend * refraction_px * (0.35 + 0.65 * crack_glow);
    vec2 sample_uv = clamp(
        effect_texture_uv_from_content_px(effect, sample_px),
        vec2(0.0),
        vec2(1.0)
    );

    vec4 backdrop = texture2D(tex, sample_uv);
    vec4 clear_backdrop = texture2D(tex, effect.texture_uv);

    // Frost as ragged rime rather than a soft veil: a ridged vein field is
    // thresholded by the coverage drive (patches + border creep), so the
    // frost boundary stays crisp and dendritic at any coverage level instead
    // of fading out as a smooth gradient.
    vec2 frost_uv = ice_uv * max(frost_scale, 0.001);
    // The finest octave stays low-frequency enough that thresholding does not
    // shed isolated single-pixel dots around the frost boundary.
    float veins =
        0.55 * ridge(frost_uv + vec2(19.19, 33.33)) +
        0.30 * ridge(frost_uv * 2.53 + vec2(7.31, 3.71)) +
        0.15 * value_noise(frost_uv * 5.1);

    // Border distance measured in pixels so the creep depth is identical on
    // every edge of every surface size.
    vec2 edge_dist_px = min(frag, safe_size - frag);
    float border = 1.0 - smoothstep(
        0.0,
        max(edge_frost_px, 1.0),
        min(edge_dist_px.x, edge_dist_px.y)
    );

    float coverage = clamp(
        frost_amount * 0.45 + edge_frost * border * (0.7 + 0.3 * veins),
        0.0,
        1.0
    );
    float frost = smoothstep(1.0 - coverage, 1.16 - coverage, veins);

    // Clumpy albedo variation: small-scale fbm is spatially correlated, so
    // the frost interior reads as packed ice crystals rather than per-pixel
    // static.
    float clump = fbm(frost_uv * 5.7 + vec2(3.1, 27.7));

    vec3 ice_color = mix(
        backdrop.rgb,
        backdrop.rgb * vec3(0.82, 0.93, 1.08),
        ice_tint
    );
    // The clump field modulates both the frost tone and its opacity; opacity
    // tops out below 1 to keep the backdrop faintly visible through even the
    // densest frost.
    vec3 frost_color = mix(
        vec3(0.72, 0.82, 0.94),
        vec3(0.97, 1.0, 1.04),
        clamp(clump * 0.8 + veins * 0.35, 0.0, 1.0)
    );
    ice_color = mix(ice_color, frost_color, frost * (0.50 + 0.22 * clump));
    ice_color += vec3(0.85, 0.95, 1.0) * crack * crack_intensity;
    ice_color += vec3(0.30, 0.42, 0.55) * crack_glow * crack_intensity * 0.3;

    // ice_opacity is the translucency of the ice sheet itself: blending back
    // toward the undistorted backdrop keeps the desktop readable through it.
    vec3 final_color = mix(clear_backdrop.rgb, ice_color, ice_opacity);
    return vec4(final_color, backdrop.a);
}
