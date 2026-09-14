uniform float time;
uniform float wave_speed;
uniform float wave_speed_x;
uniform float wave_speed_y;
uniform float emboss;
uniform float intensity;
uniform float frequency;
uniform float refraction_strength;
uniform float reflection_gain;
uniform float reflection_cutoff;
uniform float reflection_intensity;
uniform float water_tint;

const float PI = 3.1415926535897932;
const int STEPS = 8;
const int ANGLE = 7;

float water_height(vec2 coord, float t) {
    float delta_theta = 2.0 * PI / float(ANGLE);
    float height = 0.0;

    for (int i = 0; i < STEPS; i++) {
        float theta = delta_theta * float(i);
        vec2 adjusted = coord;
        adjusted.x += cos(theta) * t * wave_speed + t * wave_speed_x;
        adjusted.y -= sin(theta) * t * wave_speed - t * wave_speed_y;
        height += cos(
            (adjusted.x * cos(theta) - adjusted.y * sin(theta)) * frequency
        ) * intensity;
    }

    return cos(height);
}

vec4 shader_main(EffectContext effect) {
    vec2 uv = effect_content_uv(effect);
    vec2 rect_size = effect.content_rect_px.zw;
    vec2 safe_size = max(rect_size, vec2(1.0));
    float t = time * 1.3;

    float center = water_height(uv, t);
    vec2 sample_delta = 1.0 / safe_size;

    float dx = emboss *
        (center - water_height(uv + vec2(sample_delta.x, 0.0), t));
    float dy = emboss *
        (center - water_height(uv + vec2(0.0, sample_delta.y), t));

    vec2 refracted_px =
        (uv + vec2(dx, dy) * refraction_strength) * safe_size;
    vec2 refracted_uv = clamp(
        effect_texture_uv_from_content_px(effect, refracted_px),
        vec2(0.0),
        vec2(1.0)
    );

    float alpha = max(0.0, 1.0 + dx * dy * reflection_gain);
    float reflect_x = dx - reflection_cutoff;
    float reflect_y = dy - reflection_cutoff;
    if (reflect_x > 0.0 && reflect_y > 0.0) {
        alpha = pow(alpha, reflect_x * reflect_y * reflection_intensity);
    }

    vec4 color = texture2D(tex, refracted_uv);

    vec2 light_dir = normalize(vec2(-0.35, -0.8));
    float ripple_light = clamp(
        dot(normalize(vec2(dx, dy) + 0.0001), light_dir),
        0.0,
        1.0
    );
    vec3 tint = mix(vec3(water_tint), vec3(0.70, 0.88, 1.08), 0.25);
    color.rgb = color.rgb * tint * clamp(alpha, 0.72, 1.55);
    color.rgb += vec3(0.16, 0.24, 0.30) * ripple_light * 0.22;

    float vignette =
        smoothstep(0.0, 0.25, uv.y) * smoothstep(1.0, 0.72, uv.y);
    color.rgb *= mix(0.88, 1.04, vignette);

    return vec4(color.rgb, color.a);
}
