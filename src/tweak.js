// Live tuning of the cut-face stone, one folder per cut-face colour of the
// current model. Loaded only with ?tweak in the URL. "Copy prompt" puts a
// prompt on the clipboard that asks an LLM to write the current values into
// stone-presets.js as that model's entry.
import { Pane } from "tweakpane";

const RANGES = {
  roughness: { min: 0, max: 1 },
  metalness: { min: 0, max: 1 },
  chipDensity: { min: 0, max: 2 },
  chipEmbed: { min: 0, max: 1 },
  veinStrength: { min: 0, max: 1 },
  veinScale: { min: 0.02, max: 1 },
  veinWave: { min: 0, max: 3 },
  veinLayers: { min: 0, max: 2 },
  veinAngle: { min: -90, max: 90 },
  veinWidth: { min: 0, max: 1 },
  veinContrast: { min: 0, max: 1 },
  cloudStrength: { min: 0, max: 0.6 },
  emissive: { min: 0, max: 1.5 }
};
const DECIMALS = 3;

const round = (value) => Number(value.toFixed(DECIMALS));

// The model's entry for STONE_PRESETS: per colour, only the values that differ
// from what they would fall back to.
function presetEntry(entries) {
  const result = {};
  for (const { hex, settings, base } of entries) {
    const changes = {};
    if (settings.chipColors.join() !== base.chipColors.join()) changes.chipColors = [...settings.chipColors];
    if (settings.veinColor !== base.veinColor) changes.veinColor = settings.veinColor;
    for (const key of Object.keys(RANGES)) {
      if (round(settings[key]) !== round(base[key])) changes[key] = round(settings[key]);
    }
    if (Object.keys(changes).length) result[hex] = changes;
  }
  return result;
}

function buildPrompt(model, entries) {
  const json = JSON.stringify(presetEntry(entries), null, 2);
  return [
    `In src/stone-presets.js, replace the \`${model.id}\` entry of STONE_PRESETS with the JSON below (add the entry if it is missing). It holds the cut-face stone settings for the "${model.name}" model, keyed by cut-face colour as sRGB hex; a colour's settings override STONE_DEFAULTS and the model's own roughness/metalness (chipColors lists the chips' four tones and veinColor the veins' colour, as sRGB hex). Only values that differ from those fallbacks are listed, so write exactly these keys and no others. If the JSON is empty, remove the entry instead. Leave the other models' entries and the rest of the file unchanged, and match the file's formatting.`,
    "",
    "```json",
    json,
    "```"
  ].join("\n");
}

export function createStoneTweaks(onChange) {
  const container = document.createElement("div");
  container.className = "tweak-pane";
  document.body.append(container);
  const pane = new Pane({ container, title: "Stone" });
  let folders = [];
  let actions = [];
  // Hidden until the page's toggle opens it; show() only fills it.
  pane.hidden = true;

  function flash(button, title) {
    const original = button.title;
    button.title = title;
    setTimeout(() => { button.title = original; }, 1200);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("Clipboard write failed; the prompt follows.", error);
      console.log(text);
      return false;
    }
  }

  // Back to what the colour would get without a preset entry.
  function reset(entry) {
    Object.assign(entry.settings, structuredClone(entry.base));
    onChange(entry);
  }

  let shown = null;

  function show(model, entries) {
    shown = { model, entries };
    for (const item of [...folders, ...actions]) item.dispose();
    folders = [];
    actions = [];
    pane.title = `Stone: ${model.name}`;

    for (const entry of entries) {
      const folder = pane.addFolder({ title: entry.hex, expanded: entries.length === 1 });
      const swatch = document.createElement("i");
      swatch.className = "tweak-swatch";
      swatch.style.background = entry.hex;
      folder.element.querySelector(".tp-fldv_b")?.prepend(swatch);
      // The chip colours are bound through a copy, one key per chip.
      const chips = Object.fromEntries(entry.settings.chipColors.map((hex, index) => [`chip ${index + 1}`, hex]));
      Object.keys(chips).forEach((key, index) => {
        folder.addBinding(chips, key, { view: "color" }).on("change", ({ value }) => {
          entry.settings.chipColors[index] = value;
          onChange(entry);
        });
      });
      folder.addBinding(entry.settings, "veinColor", { view: "color", label: "vein" })
        .on("change", () => onChange(entry));
      for (const [key, range] of Object.entries(RANGES)) {
        folder.addBinding(entry.settings, key, { ...range, step: 0.001 })
          .on("change", () => onChange(entry));
      }
      folder.addButton({ title: "Reset this colour" }).on("click", () => {
        reset(entry);
        show(shown.model, shown.entries);
      });
      folders.push(folder);
    }

    const copyButton = pane.addButton({ title: "Copy prompt" });
    copyButton.on("click", async () => {
      flash(copyButton, (await copy(buildPrompt(model, entries))) ? "Copied" : "Copy failed; see console");
    });
    const resetButton = pane.addButton({ title: "Reset all colours" });
    resetButton.on("click", () => {
      entries.forEach(reset);
      show(shown.model, shown.entries);
    });
    actions.push(copyButton, resetButton);
  }

  function setVisible(visible) {
    pane.hidden = !visible;
  }

  return { show, setVisible };
}
