uniform float time;
uniform float rain_density;
uniform float drop_chance;
uniform float ripple_speed;
uniform float ripple_size;
uniform float ripple_strength;
uniform float ripple_frequency;
uniform float ripple_decay;
uniform float refraction_strength;
uniform float highlight_intensity;
uniform float highlight_sharpness;
uniform float rain_tint;

const int MAX_RADIUS = 2;
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

vec4 shader_main(EffectContext effect) {
    vec2 uv = effect_content_uv(effect);
    vec2 rect_size = effect.content_rect_px.zw;
    vec2 safe_size = max(rect_size, vec2(1.0));
    float aspect = safe_size.x / safe_size.y;
    float density = max(rain_density, 1.0);
    vec2 rain_uv = vec2(uv.x * aspect, uv.y) * density;
    vec2 cell = floor(rain_uv);

    vec2 ripples = vec2(0.0);
    float active_cells = 0.0;

    for (int y = -MAX_RADIUS; y <= MAX_RADIUS; y++) {
        for (int x = -MAX_RADIUS; x <= MAX_RADIUS; x++) {
            vec2 cell_id = cell + vec2(float(x), float(y));
            float cell_hash = hash12(cell_id);

            if (cell_hash > drop_chance) {
                continue;
            }

            vec2 drop_center = cell_id + hash22(cell_id);
            float drop_time = fract(time * ripple_speed + cell_hash);
            vec2 to_drop = drop_center - rain_uv;
            float ring_radius =
                (float(MAX_RADIUS) + 1.0) * drop_time * ripple_size;
            float signed_dist = length(to_drop) - ring_radius;

            float h = 0.001;
            float d1 = signed_dist - h;
            float d2 = signed_dist + h;
            float p1 =
                sin(ripple_frequency * d1) *
                smoothstep(-0.6, -0.3, d1) *
                smoothstep(0.0, -0.3, d1);
            float p2 =
                sin(ripple_frequency * d2) *
                smoothstep(-0.6, -0.3, d2) *
                smoothstep(0.0, -0.3, d2);
            float fade = pow(1.0 - drop_time, ripple_decay);

            ripples +=
                0.5 *
                normalize(to_drop + 0.0001) *
                ((p2 - p1) / (2.0 * h)) *
                fade *
                ripple_strength;
            active_cells += 1.0;
        }
    }

    ripples /= max(active_cells, 1.0);
    ripples = clamp(ripples, vec2(-0.35), vec2(0.35));

    vec3 normal = vec3(ripples, sqrt(max(0.0, 1.0 - dot(ripples, ripples))));
    vec2 sample_px = (uv - normal.xy * refraction_strength) * safe_size;
    vec2 sample_uv = clamp(
        effect_texture_uv_from_content_px(effect, sample_px),
        vec2(0.0),
        vec2(1.0)
    );

    vec4 color = texture2D(tex, sample_uv);
    vec3 light_dir = normalize(vec3(1.0, 0.7, 0.5));
    float highlight = pow(
        clamp(dot(normal, light_dir), 0.0, 1.0),
        max(highlight_sharpness, 1.0)
    );

    color.rgb = color.rgb * vec3(rain_tint);
    color.rgb += vec3(highlight_intensity) * highlight;

    return vec4(color.rgb, color.a);
}
