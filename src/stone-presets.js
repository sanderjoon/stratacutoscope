// Cut-face stone settings per model, keyed by the cut face's base colour: the
// mesh's vertex colour as sRGB hex. Any colour without an entry, and any value
// an entry leaves out, falls back to STONE_DEFAULTS; roughness and metalness
// fall back to the model's own material.
// Open the page with ?tweak to tune these live; the pane copies a prompt with
// a replacement entry for the current model.
export const STONE_DEFAULTS = {
  chipColors: ["#141414", "#f5efe4", "#8f8c86", "#f5efe4"], // the chips' tones, picked at random per chip
  chipDensity: 1, // multiplier on every chip layer's density
  chipEmbed: 0.5, // how far a chip's tone can sink toward the resin colour
  // Veins: bands of one colour through the resin, repeating along a direction
  // (veinLayers) and/or following noise (veinWave). Straight stripes at one
  // end, wandering marble veins at the other.
  veinColor: "#141414",
  veinStrength: 0.7, // how solidly the colour covers the resin
  veinScale: 0.22, // of the noise, in base cells; smaller is a wider, lazier wander
  veinWave: 1, // how far the noise bends the bands, in bands; 0 leaves them unbent
  veinRipple: 0, // how far a plain sine wave along the radius bends them, in bands
  veinRippleScale: 0.3, // waves of that ripple per base cell
  veinLayers: 0, // straight bands per base cell; 0 leaves only the noise
  veinAngle: 0, // degrees the bands tilt outward from horizontal, like a cone
  veinWidth: 0.08, // of each band's period that is vein
  veinContrast: 0.6, // 0: soft gradient, 1: hard edge
  cloudStrength: 0.14, // mottling of the resin's brightness
  emissive: 0.65 // how much the stone glows on its own, so the cut reads flat
};

export const STONE_PRESETS = {};

export function stoneSettings(modelId, hex, material) {
  const settings = {
    roughness: material.roughness,
    metalness: material.metalness,
    ...STONE_DEFAULTS,
    ...STONE_PRESETS[modelId]?.[hex]
  };
  // Each set of settings owns its colours, so tuning one cannot edit the defaults.
  settings.chipColors = [...settings.chipColors];
  return settings;
}
