// Cut-face stone settings per model, keyed by the cut face's base colour: the
// mesh's vertex colour as sRGB hex. Any colour without an entry, and any value
// an entry leaves out, falls back to STONE_DEFAULTS; roughness and metalness
// fall back to the model's own material.
// Open the page with ?tweak to tune these live; the pane copies a prompt with
// a replacement entry for the current model.
export const STONE_DEFAULTS = {
  chipDensity: 1, // multiplier on every chip layer's density
  chipEmbed: 0.5, // how far a chip's tone can sink toward the resin colour
  veinScale: 0.22, // in base cells; smaller is a wider, lazier vein pattern
  veinWidth: 0.07, // bold veins; the finer second set is half as wide and strong
  veinStrength: 0.7,
  cloudStrength: 0.14, // mottling of the resin's brightness
  emissive: 0.65 // how much the stone glows on its own, so the cut reads flat
};

export const STONE_PRESETS = {};

export function stoneSettings(modelId, hex, material) {
  return {
    roughness: material.roughness,
    metalness: material.metalness,
    ...STONE_DEFAULTS,
    ...STONE_PRESETS[modelId]?.[hex]
  };
}
