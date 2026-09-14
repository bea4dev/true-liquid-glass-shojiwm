vec4 shader_main(EffectContext effect) {
    vec4 source = texture2D(tex, effect.texture_uv);
    float gray = dot(source.rgb, vec3(0.299, 0.587, 0.114));
    return vec4(vec3(gray), source.a);
}
