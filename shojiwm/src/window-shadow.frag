uniform vec3 shadow_color;
uniform float shadow_opacity;
uniform vec2 shadow_offset_px;

vec4 shader_main(EffectContext effect) {
    vec2 sample_px = effect_content_px(effect) - shadow_offset_px;
    vec2 sample_uv = clamp(
        effect_texture_uv_from_content_px(effect, sample_px),
        vec2(0.0),
        vec2(1.0)
    );
    vec4 source = texture2D(tex, sample_uv);
    float alpha = source.a * shadow_opacity;
    return vec4(source.rgb * shadow_color * alpha, alpha);
}
