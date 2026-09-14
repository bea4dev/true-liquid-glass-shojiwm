// Composites the persistent ink and the ripple field over the wallpaper.
// `tex` is the wallpaper itself (layerSource via the replace slot); `ink`
// and `flow` are the half-res state textures. The ink is shaded as glossy
// paint: normals come from the ripple height field plus the coverage
// gradient (rounded rims), lit by a fixed key light with a Blinn-Phong
// highlight and an extra broad sheen while the surface is still wet.

uniform sampler2D ink;
uniform sampler2D flow;

const float RIPPLE_BUMP = 0.55;     // height-field contribution to normals
const float EDGE_BUMP = 6.0;        // coverage-gradient contribution (rims)
// A wide gradient step low-passes the half-res height field; together with
// the sim's viscosity this keeps fine shimmer out of the ink surface.
const float GRAD_STEP_PX = 5.0;
const float REFRACT_PX = 7.0;
const float SPECULAR_POWER = 30.0;
const float SPECULAR_STRENGTH = 0.32;
const float SHEEN_STRENGTH = 0.10;
const float MASK_LO = 0.22;
const float MASK_HI = 0.5;
// Near-unit light direction; +y points down in content px space, so a
// negative y means the light comes from the top of the screen.
const vec3 LIGHT_DIR = vec3(-0.35, -0.55, 0.76);

vec2 state_uv(EffectContext effect, vec2 content_px) {
    vec2 clamped = clamp(content_px, vec2(0.0), effect.content_rect_px.zw);
    return effect_texture_uv_from_content_px(effect, clamped);
}

float surface_field(EffectContext effect, vec2 content_px) {
    vec2 uv = state_uv(effect, content_px);
    float height = texture2D(flow, uv).r;
    float coverage = texture2D(ink, uv).a;
    return height * RIPPLE_BUMP + coverage * EDGE_BUMP;
}

vec4 shader_main(EffectContext effect) {
    vec2 px = effect_content_px(effect);

    float gx = surface_field(effect, px + vec2(GRAD_STEP_PX, 0.0)) -
        surface_field(effect, px - vec2(GRAD_STEP_PX, 0.0));
    float gy = surface_field(effect, px + vec2(0.0, GRAD_STEP_PX)) -
        surface_field(effect, px - vec2(0.0, GRAD_STEP_PX));
    vec3 normal = normalize(vec3(
        -gx / (2.0 * GRAD_STEP_PX),
        -gy / (2.0 * GRAD_STEP_PX),
        1.0
    ));

    vec4 paint = texture2D(ink, effect.texture_uv);
    vec4 surface = texture2D(flow, effect.texture_uv);
    float mask = smoothstep(MASK_LO, MASK_HI, paint.a);

    // Ripples refract the wallpaper; faintly outside the ink, fully on it.
    vec2 refracted_px = px + normal.xy * REFRACT_PX * (0.25 + 0.75 * mask);
    vec4 wall = texture2D(tex, state_uv(effect, refracted_px));

    vec3 color = paint.rgb;
    // Splatoon-style darker rim right at the ink boundary.
    float rim = mask * (1.0 - smoothstep(MASK_HI, 0.85, paint.a));
    color *= 1.0 - 0.12 * rim;
    // Height shading gives the surface its rolling, liquid look.
    color *= 1.0 + clamp(surface.r * 0.012, -0.1, 0.1);

    vec3 half_dir = normalize(LIGHT_DIR + vec3(0.0, 0.0, 1.0));
    float facing = max(dot(normal, half_dir), 0.0);
    float diffuse = max(dot(normal, LIGHT_DIR), 0.0);
    float specular = pow(facing, SPECULAR_POWER) * SPECULAR_STRENGTH;
    float sheen = pow(facing, 6.0) * SHEEN_STRENGTH * surface.b;

    vec3 lit = color * (0.90 + 0.14 * diffuse) + vec3(specular + sheen);

    vec3 final_color = mix(wall.rgb, lit, mask);
    return vec4(final_color, wall.a);
}
