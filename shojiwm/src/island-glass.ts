import {
  backdropSource, compileLayerEffect, dualKawaseBlur, get, layerSource,
  loadShader, save, shaderStage, renderTo, stateTexture,
} from "shoji_wm";

// All distances are framebuffer pixels. This pipeline knows only the alpha
// silhouette: no shape count, positions, or corner radii come from QuickShell.
export const ISLAND_GLASS_OPTIONS = {
  rimWidth: 30,
  refraction: 30,
  chromaticShift: 0.90,
  highlight: 1.0,
  blurRadius: 4,
  blurPasses: 2,
  blurMix: 1,
  normalSmoothing: 3,
  edgeSoftness: 2,
  bevelWidth: 10,
  bevelShadow: 0,
  // 0: glass, 1: mask, 2: distance, 3: surface gradient.
  debugView: 0,
};

// Float local boundary offsets / signed distances retain subpixel precision.
// Overwritten from the current mask each refresh; no temporal feedback.
const distanceField = stateTexture("island-distance-v2", {
  format: "rgba16f", scale: 1, resize: "clear",
});

export const ISLAND_GLASS = compileLayerEffect({
  input: backdropSource(),
  capturePadding: 64,
  alpha: "preserve",
  // A silhouette change affects an entire rim, not just the damaged pixel.
  invalidate: { kind: "on-source-damage-box", damagePadding: 64 },
  pipeline: [
    save("island-sharp"),
    dualKawaseBlur({ radius: ISLAND_GLASS_OPTIONS.blurRadius, passes: ISLAND_GLASS_OPTIONS.blurPasses }),
    save("island-soft"),
    dualKawaseBlur({ radius: 3, passes: 2 }),
    save("island-edge-soft"),
    shaderStage(loadShader("./src/island-mask.frag"), {
      textures: { layer_mask: layerSource() },
      uniforms: { alpha_threshold: 0.10, alpha_feather: 0.02 },
    }),
    save("island-mask"),
    renderTo(distanceField, {
      // Already aligned to the padded backdrop. Direct layerSource here would
      // stretch the unpadded layer to the renderTo canvas.
      input: get("island-mask"),
      pipeline: [
        // Float-prefilter the silhouette before selecting boundary seeds.
        // The final clip still uses the original mask, so UI edges stay crisp.
        shaderStage(loadShader("./src/island-smooth.frag"), {
          uniforms: { axis: [1, 0] as const, smoothing_px: 1 },
          textures: { field_input: get("island-mask") },
        }),
        save("island-seed-mask-x"),
        shaderStage(loadShader("./src/island-smooth.frag"), {
          uniforms: { axis: [0, 1] as const, smoothing_px: 1 },
          textures: { field_input: get("island-seed-mask-x") },
        }),
        save("island-seed-mask"),
        shaderStage(loadShader("./src/island-seed.frag"), {
          textures: { mask_input: get("island-seed-mask") },
        }),
        save("island-float-step"),
        ...[64, 32, 16, 8, 4, 2, 1, 1].flatMap((jump) => [
          shaderStage(loadShader("./src/island-jump.frag"), {
            uniforms: { jump_px: jump },
            textures: { field_input: get("island-float-step") },
          }),
          save("island-float-step"),
        ]
        ),
        shaderStage(loadShader("./src/island-height.frag"), {
          textures: { silhouette: get("island-seed-mask"), field_input: get("island-float-step") },
          uniforms: { distance_limit_px: 120 },
        }),
        save("island-float-step"),
        shaderStage(loadShader("./src/island-smooth.frag"), {
          uniforms: { axis: [1, 0] as const, smoothing_px: ISLAND_GLASS_OPTIONS.normalSmoothing },
          textures: { field_input: get("island-float-step") },
        }),
        save("island-float-step"),
        shaderStage(loadShader("./src/island-smooth.frag"), {
          uniforms: { axis: [0, 1] as const, smoothing_px: ISLAND_GLASS_OPTIONS.normalSmoothing },
          textures: { field_input: get("island-float-step") },
        }),
        // Keep the float result directly in the raw multi-texture coordinate
        // system; avoid the separate color-copy path used by state commit.
        save("island-distance-ready"),
      ],
    }),
    shaderStage(loadShader("./src/island-refract.frag"), {
      textures: {
        sharp_scene: get("island-sharp"),
        soft_scene: get("island-soft"),
        edge_scene: get("island-edge-soft"),
        silhouette: get("island-mask"),
        distance_field: get("island-distance-ready"),
      },
      uniforms: {
        rim_width_px: ISLAND_GLASS_OPTIONS.rimWidth,
        refraction_px: ISLAND_GLASS_OPTIONS.refraction,
        chromatic_shift_px: ISLAND_GLASS_OPTIONS.chromaticShift,
        highlight_strength: ISLAND_GLASS_OPTIONS.highlight,
        debug_view: ISLAND_GLASS_OPTIONS.debugView,
        blur_mix: ISLAND_GLASS_OPTIONS.blurMix,
        edge_softness_px: ISLAND_GLASS_OPTIONS.edgeSoftness,
        bevel_width_px: ISLAND_GLASS_OPTIONS.bevelWidth,
        bevel_shadow: ISLAND_GLASS_OPTIONS.bevelShadow,
      },
    }),
  ],
});
