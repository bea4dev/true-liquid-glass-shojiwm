uniform sampler2D layer_mask;
uniform float alpha_threshold;
uniform float alpha_feather;

vec4 shader_main(EffectContext effect) {
    float alpha = texture2D(layer_mask, effect.texture_uv).a;
    float coverage = smoothstep(alpha_threshold - alpha_feather,
                                alpha_threshold + alpha_feather, alpha);
    // Opaque intermediate data, not a premultiplied display color.
    return vec4(vec3(coverage), 1.0);
}
