// Cut-face stone settings per model, keyed by the cut face's base colour: the
// mesh's vertex colour as sRGB hex. Any colour without an entry, and any value
// an entry leaves out, falls back to STONE_DEFAULTS; roughness and metalness
// fall back to the model's own material.
// Open the page with ?tweak to tune these live; the pane copies a prompt with
// a replacement entry for the current model.
export const STONE_DEFAULTS = {
  chipColors: ["#ffe9c4", "#c38e2c", "#f2ccc2", "#fbefd8"], // the chips' tones, picked at random per chip
  chipDensity: 0.05, // multiplier on every chip layer's density
  chipEmbed: 0, // how far a chip's tone can sink toward the resin colour
  // Veins: bands of one colour through the resin, repeating along a direction
  // (veinLayers) and/or following noise (veinWave). Straight stripes at one
  // end, wandering marble veins at the other.
  veinColor: "#000000",
  veinStrength: 1, // how solidly the colour covers the resin
  veinScale: 0.5, // of the noise, in base cells; smaller is a wider, lazier wander
  veinWave: 1, // how far the noise bends the bands, in bands; 0 leaves them unbent
  veinRipple: 0, // how far a plain sine wave along the radius bends them, in bands
  veinRippleScale: 0.3, // waves of that ripple per base cell
  veinLayers: 0, // straight bands per base cell; 0 leaves only the noise
  veinAngle: 0, // degrees the bands tilt outward from horizontal, like a cone
  veinWidth: 0.2, // of each band's period that is vein
  veinContrast: 1, // 0: soft gradient, 1: hard edge
  cloudStrength: 0.14, // mottling of the resin's brightness
  emissive: 0.65 // how much the stone glows on its own, so the cut reads flat
};

export const STONE_PRESETS = {
  bouncingballs: {
    "#7b7b7b": {
      veinColor: "#ff9000",
      veinStrength: 1,
      veinWidth: 0.761,
      veinContrast: 1
    },
    "#5b5b5b": {
      veinColor: "#9400ff",
      veinStrength: 1,
      veinScale: 1,
      veinWidth: 0.478,
      veinContrast: 1
    },
    "#c1c1c1": {
      veinColor: "#00ff4f",
      veinStrength: 1,
      veinScale: 0.968,
      veinWidth: 0.761,
      veinContrast: 1
    }
  },
  dialogue: {
    "#d40000": {
      chipColors: ["#991b1b", "#7f5c1b", "#b2811e", "#a5164a"],
      veinColor: "#af0000",
      chipDensity: 0.022,
      chipEmbed: 0.565,
      veinStrength: 1,
      veinScale: 1,
      veinWave: 0.815,
      veinRipple: 0.783,
      veinRippleScale: 0.241,
      veinLayers: 1.674,
      veinAngle: 17.609,
      veinWidth: 0.489,
      cloudStrength: 0,
      emissive: 1.5
    },
    "#ffeb8e": {
      chipColors: ["#b85b5b", "#b8924c", "#66480d", "#956b1e"],
      chipDensity: 2,
      veinStrength: 0
    }
  },
  handshake: {
    "#4c76d7": {
      chipColors: ["#fff7cc", "#fff0d7", "#fff7e8", "#ffe6ba"],
      veinColor: "#db7777",
      chipDensity: 0.13,
      veinStrength: 0.674,
      veinScale: 0.595,
      veinWidth: 0.13,
      veinContrast: 1
    },
    "#df9851": {
      veinColor: "#cc74a9",
      chipDensity: 0,
      chipEmbed: 0.217,
      veinStrength: 0.707,
      veinScale: 0.361,
      veinWidth: 0.098,
      veinContrast: 1
    },
    "#ffe4c9": {
      veinColor: "#999400",
      chipDensity: 0.217,
      veinStrength: 1
    },
    "#1939d3": {
      veinColor: "#923270",
      chipDensity: 0,
      veinStrength: 0.304,
      veinScale: 0.574,
      veinWidth: 0.13,
      veinContrast: 1,
      emissive: 1.5
    },
    "#0033ab": {
      veinColor: "#923270",
      roughness: 0,
      chipDensity: 0,
      veinStrength: 0.098,
      veinWidth: 0.109,
      emissive: 1.5
    },
    "#c1780c": {
      veinColor: "#cc72bb",
      chipDensity: 0,
      veinStrength: 1,
      veinWidth: 0.043,
      veinContrast: 1
    }
  },
  horse: {
      "#a0730f": {
    "chipColors": [
      "#33af64",
      "#ff0000",
      "#464646",
      "#797979"
    ],
    "veinColor": "#ffd900",
    "chipDensity": 0.283,
    "veinStrength": 0.087,
    "veinScale": 1,
    "veinWave": 0.391,
    "veinWidth": 0.348,
    "cloudStrength": 0
  },
  "#724c00": {
    "veinColor": "#ac4500",
    "chipDensity": 0.326,
    "veinWidth": 0.75
  },
  "#ffc440": {
    "chipColors": [
      "#ff00ce",
      "#c38e2c",
      "#f2ccc2",
      "#fbefd8"
    ],
    "veinColor": "#ffe8cc",
    "metalness": 0,
    "chipDensity": 2,
    "veinScale": 0.553,
    "veinWave": 1.402,
    "veinWidth": 0.913,
    "cloudStrength": 0,
    "emissive": 0.636
  },
  "#ff8787": {
    "veinColor": "#fffc99",
    "chipDensity": 2,
    "veinScale": 1
  },
  "#2f3141": {
    "veinColor": "#c82194",
    "veinScale": 1
  }
  },
  rotatinghead: {
    "#a09500": {
      chipColors: ["#ffb5b5", "#f5efe4", "#ffc95e", "#f5efe4"],
      veinColor: "#ff3e3e",
      chipDensity: 0.001,
      veinScale: 1,
      veinWidth: 0.772,
      veinContrast: 1
    },
    "#970d0d": {
      veinColor: "#ff0000",
      chipDensity: 0.001,
      veinStrength: 0.261,
      veinScale: 0.329,
      veinContrast: 1
    },
    "#ffffa3": {
      veinColor: "#ffef16",
      chipDensity: 2,
      veinStrength: 1,
      veinScale: 0.276,
      veinContrast: 1
    },
    "#ffbad6": {
      veinColor: "#ffa0a0",
      veinStrength: 1,
      veinScale: 1,
      veinWave: 0,
      veinRippleScale: 0.368,
      veinWidth: 0.902,
      veinContrast: 1,
      cloudStrength: 0,
      emissive: 1.5
    },
    "#009910": {
      veinColor: "#8066ff",
      chipDensity: 0,
      veinStrength: 1,
      veinScale: 0.798,
      veinWidth: 0.489,
      veinContrast: 1
    },
    "#eae7ba": {
      veinColor: "#fff92e",
      chipDensity: 0.283,
      chipEmbed: 1,
      veinStrength: 1,
      veinWidth: 0.348,
      veinContrast: 1
    },
    "#b90505": {
      veinColor: "#5d44ff",
      chipDensity: 0,
      chipEmbed: 0,
      veinStrength: 1,
      veinScale: 1,
      veinWidth: 0.815,
      veinContrast: 1
    }
  },
  walker: {
    "#a38719": {
      veinColor: "#ff5c5c",
      veinScale: 0.499,
      veinRippleScale: 0.262,
      veinWidth: 0.337,
      emissive: 0.587
    },
    "#2f5fd6": {
      veinColor: "#c527b4",
      chipDensity: 0.109,
      veinStrength: 0.652,
      veinScale: 0.68
    },
    "#44963f": {
      veinColor: "#6259bc",
      veinWidth: 0.13
    },
    "#c74c1d": {
      chipColors: ["#d45aff", "#0eff45", "#ff3500", "#ffc047"],
      veinColor: "#8779c8",
      chipDensity: 1.043,
      veinScale: 1,
      veinWave: 1.402,
      veinRippleScale: 0.05,
      veinWidth: 0.478,
      emissive: 0.538
    },
    "#e89ed1": {
      veinColor: "#27db2c"
    },
    "#e1e5a8": {
      veinColor: "#5e1692",
      chipDensity: 0,
      veinScale: 1,
      veinWave: 0.946,
      veinRippleScale: 2,
      veinAngle: -3.913,
      veinWidth: 0.141
    },
    "#e3e89e": {
      veinColor: "#ff3232",
      veinStrength: 0.696,
      veinScale: 0.904
    },
    "#d62fa3": {
      veinColor: "#820f0f",
      veinWidth: 0.674
    },
    "#ffffff": {
      veinColor: "#ef0000"
    },
    "#e30000": {
      veinColor: "#ff3eb3",
      veinScale: 1
    }
  }
};

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
