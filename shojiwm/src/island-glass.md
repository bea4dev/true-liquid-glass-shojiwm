# LiquidIsland: mask-driven glass

`index.tsx` applies `ISLAND_GLASS` only to the layer-shell namespace
`liquid-island-qs`, using the `behind` slot. QuickShell draws the shape and
foreground text; ShojiWM distorts the scene below it. QuickShell files are not
modified by this effect.

## Pipeline

1. Save the sharp background, a blurred version, and a second softer version
   for the outer lens region.
2. Read `layerSource().a`, threshold at 0.10 with a 0.02 transition, and save
   the silhouette in the same padded coordinate system as the background.
3. Prefilter a float copy of the mask before finding subpixel boundary seeds.
   Keep the original mask for final clipping, so visible edges are not blurred.
4. Propagate nearest boundary offsets with bounded jump flooding:
   64, 32, 16, 8, 4, 2, 1, 1 pixels. RGBA16F stores local pixel offsets and a valid
   flag. Local offsets and explicit highp samplers preserve subpixel precision.
5. Compute a signed distance (positive inside), then smooth it horizontally
   and vertically with a five-tap kernel, still in floating point.
6. Use a spatially averaged Sobel derivative to obtain the inward normal. Independently compute
   `x = 1 - clamp(distance / rimWidth, 0, 1)` and
   `profile = 1 - sqrt(1 - x*x)`, then sample the background
   at `pixel + inwardNormal * strength * profile * coherence`.
7. Split RGB around the refracted position along the normal, using a separate
   circular profile over the outer half of the rim. Add directional rim light
   and clip using the original mask. `blurMix` controls blurred/sharp sampling.

The circular profile follows [Aghajari's article](https://www.aghajari.com/publications/liquid-glass/).
Unlike the article's center-based radial direction, this implementation uses
the mask boundary normal to support splitting and arbitrary shapes. Four
subpixel profile evaluations average over one framebuffer pixel at the steep
rim; they do not add background texture fetches. At half the rim width the
ideal circular profile is about 0.134, versus 0.5 for the previous smoothstep.
The implemented curve additionally regularizes the rim singularity with
`e = edgeSoftness / rimWidth` and
`(sqrt(1+e) - sqrt(1-x*x+e)) / (sqrt(1+e) - sqrt(e))`.
This retains the circular profile and its endpoints, with a finite edge slope.
No frame-history blending is used, so splitting shapes leave no temporal ghosts.

The reference Dock screenshot motivates a thin neutral reflection, a broader
inset shadow and extra blur near the edge. These are visual approximations:
a screenshot cannot uniquely identify Apple's refraction or lighting functions.

At narrow necks, the signed-distance gradient loses magnitude as opposing
normals meet. Coherence attenuates refraction there rather than amplifying a
nearly zero vector. Thin bridges remain an important visual test case.

The entire distance side pipeline uses the raw multi-texture drawing path.
Mixing it with the single-texture color drawing path caused coordinate mismatches
in the first implementation (visibly missing top-edge normals). The final float
texture is used through a named save directly, avoiding the state-commit copy.
`renderTo` establishes float intermediate targets; its persistent copy is unused.
No packed color bytes or quantized 8-bit heights are differentiated anymore.

## Tuning

Edit `ISLAND_GLASS_OPTIONS` in `island-glass.ts`, then reload ShojiWM with
Super+Shift+R:

- `rimWidth`: depth of the rounded edge, currently 50.
- `refraction`: requested displacement, capped at `rimWidth` (both currently
  50 px). The steep circular profile permits sample-coordinate foldover near
  the rim, as in the tutorial; lower this if the lensing is too strong.
- `chromaticShift`: RGB sample separation, currently 0.90.
- `highlight`: rim light strength, initially 0.22.
- `blurRadius` / `blurPasses`: currently 2 / 2. Both are integers. The outer edge
  blends up to 80% toward an additional radius-3, two-pass blur of this image.
- `normalSmoothing`: signed-distance smoothing stride in framebuffer px, default 3.
  Increasing it stabilizes corners but softens fine geometric detail.
- `edgeSoftness`: regularization of the circular lens rim, default 2 px.
- `bevelWidth`: width of inset shading, default 10 px.
- `bevelShadow`: inset shadow strength, currently 0 (disabled).
- `blurMix`: 1 = fully blurred source, 0 = sharp source. Previously hardcoded
  to 0.18, which left most of the background sharp even with strong blur settings.
- `debugView`: 0 = glass, 1 = silhouette, 2 = distance, 3 = gradient.

Distances are framebuffer pixels, so apparent width varies with display scale.
Keep `rimWidth` at or below 96 with this jump schedule (about 128 px propagation
reach), leaving room for smoothing. Beyond that, extend the jump schedule.
Capture padding is 64 logical pixels; increase it if sampling outside the window
with a much larger refraction displacement. Debug views still appear beneath
the original QuickShell surface and therefore inherit its tint.

## Scope and cost

This is an approximate screen-space refraction effect, not a physical ray tracer
or Apple's implementation. Shape changes and source damage invalidate the
pipeline. There is no CPU readback, animation-history feedback, or full-screen
distance texture, but each invalidation runs the entire per-layer pipeline;
mask-only caching and lower-resolution distance processing are not implemented.
The current full-resolution path is intended for a small widget. A full-screen
transparent shell surface would allocate and process that full rectangle.

The alpha silhouette contains everything QuickShell draws, including text and
shadows. Text fully inside a filled shape does not create holes in this mask.
Completely transparent glass has no retrievable silhouette. With the current
QuickShell tint alpha of 0.58, the source surface darkens the glass rendered
underneath; change that separately if a clearer material is desired.

Removing the namespace branch in `index.tsx` restores the previous general
layer blur. The older rounded-rectangle `liquid-glass.frag` remains independent.
