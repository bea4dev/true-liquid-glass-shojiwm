// Composites the simulated water surface over the wallpaper. `tex` is the
// wallpaper after a slight blur, `sharp` is the same wallpaper untouched, and
// `flow` is the half-res simulation state (R = height, G = velocity).
//
// The optics follow water-terminal.frag: an embossed height gradient refracts
// what is underneath, the dx*dy product drives the bright reflection lobes,
// and a cool tint plus a directional ripple light finish it. Unlike that
// shader there is no standing wave pattern of its own — the height field is
// purely the simulation, so a settled surface is perfectly flat and the
// wallpaper shows through undistorted.

uniform sampler2D flow;
uniform sampler2D sharp;

uniform float emboss;
uniform float ripple_gain;        // simulation height -> shading height
uniform float refraction_px;      // max refraction offset in px
uniform float reflection_gain;
uniform float reflection_cutoff;
uniform float reflection_intensity;
uniform float specular_strength;
uniform float water_tint;
// Fades the whole effect out against the untouched wallpaper as the surface
// settles. It reaches 0 shortly before water.ts detaches the effect
// altogether, so the wallpaper is already rendering exactly as it will
// without us and the handover is invisible.
uniform float presence;

// Wide enough to low-pass the half-res simulation texture, so the shading
// never turns single texels into sparkle.
const float GRAD_STEP_PX = 3.0;

// Soft clip, so the shading knobs stay meaningful no matter how hard the
// simulation was hit: gentle ripples scale linearly, a violent splash rolls
// off towards +/-1 instead of tearing the refraction apart.
float soft_clip(float value) {
    return value / (1.0 + abs(value));
}

float surface_height(EffectContext effect, vec2 content_px) {
    vec2 clamped = clamp(content_px, vec2(0.0), effect.content_rect_px.zw);
    vec2 uv = effect_texture_uv_from_content_px(effect, clamped);
    return soft_clip(texture2D(flow, uv).r * ripple_gain);
}

vec4 shader_main(EffectContext effect) {
    vec2 px = effect_content_px(effect);

    float center = surface_height(effect, px);
    float dx = emboss *
        (center - surface_height(effect, px + vec2(GRAD_STEP_PX, 0.0)));
    float dy = emboss *
        (center - surface_height(effect, px + vec2(0.0, GRAD_STEP_PX)));

    vec2 refracted_px = px + vec2(dx, dy) * refraction_px;
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
    color.rgb += vec3(0.16, 0.24, 0.30) * ripple_light * specular_strength;

    // No vignette: that was a terminal-window flourish, and on a wallpaper it
    // would be one more thing visible while the water is perfectly still.
    // Cross-fade against the unblurred, undistorted wallpaper: at presence 0
    // this pass is a no-op and detaching it changes nothing on screen.
    vec4 bare = texture2D(sharp, effect.texture_uv);
    return vec4(mix(bare.rgb, color.rgb, presence), color.a);
}
