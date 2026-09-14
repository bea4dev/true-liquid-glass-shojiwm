#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 resolution;
    vec4 tint;
    float blendRadius;
    int shapeCount;
    vec4 shape0;
    vec4 shape1;
    vec4 shape2;
    vec4 shape3;
    vec4 shape4;
    vec4 shape5;
    vec4 shape6;
    vec4 shape7;
    vec4 radii0;
    vec4 radii1;
};

float roundedBox(vec2 p, vec4 rect, float radius) {
    vec2 halfSize = rect.zw * 0.5;
    float r = clamp(radius, 0.0, min(halfSize.x, halfSize.y));
    vec2 q = abs(p - rect.xy - halfSize) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float mergeShape(float distance, vec2 p, vec4 rect, float radius) {
    if (min(rect.z, rect.w) <= 0.001)
        return distance;
    float other = roundedBox(p, rect, radius);
    // Reduce the joining band as a shape disappears, avoiding a residual blob.
    float k = min(max(blendRadius, 0.0), min(rect.z, rect.w));
    if (k <= 0.001)
        return min(distance, other);
    float h = max(k - abs(distance - other), 0.0) / k;
    return min(distance, other) - h * h * k * 0.25;
}

void main() {
    vec2 p = qt_TexCoord0 * resolution;
    float d = 1e6;
    if (shapeCount > 0) d = mergeShape(d, p, shape0, radii0.x);
    if (shapeCount > 1) d = mergeShape(d, p, shape1, radii0.y);
    if (shapeCount > 2) d = mergeShape(d, p, shape2, radii0.z);
    if (shapeCount > 3) d = mergeShape(d, p, shape3, radii0.w);
    if (shapeCount > 4) d = mergeShape(d, p, shape4, radii1.x);
    if (shapeCount > 5) d = mergeShape(d, p, shape5, radii1.y);
    if (shapeCount > 6) d = mergeShape(d, p, shape6, radii1.z);
    if (shapeCount > 7) d = mergeShape(d, p, shape7, radii1.w);
    float aa = max(fwidth(d), 0.001);
    float coverage = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
    // QColor uniforms are already premultiplied by Qt; preserve that alpha.
    fragColor = tint * coverage * qt_Opacity;
}
