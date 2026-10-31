import { resolve } from "node:path";
import { defineConfig } from "vite";
import { MODELS, inkColorFor } from "./src/models.js";

// Show the model's background and name from the first frame: a tiny inline
// script in <head> reads ?model= and sets the same custom properties main.js
// sets later, so nothing flashes the defaults before the bundle runs.
function inlineModelColours() {
  const table = Object.fromEntries(
    MODELS.map((model) => [model.id, [model.backgroundColor, inkColorFor(model.backgroundColor), model.name]])
  );
  const script = `(function(){var c=${JSON.stringify(table)};` +
    `var m=c[new URLSearchParams(location.search).get("model")];if(!m)return;` +
    `var s=document.documentElement.style;s.setProperty("--bg",m[0]);s.setProperty("--ink-fallback",m[1]);` +
    `s.setProperty("--model-name",JSON.stringify(m[2]));` +
    `var t=document.querySelector('meta[name="theme-color"]');if(t)t.content=m[0];})()`;
  return {
    name: "inline-model-colours",
    transformIndexHtml: {
      order: "pre",
      handler: (html, context) =>
        context.path === "/index.html" ? [{ tag: "script", children: script, injectTo: "head" }] : []
    }
  };
}

export default defineConfig({
  // Relative URLs so the same build works at /stratacutoscope/ and /stratacutoscope/dev/.
  base: "./",
  plugins: [inlineModelColours()],
  build: {
    // three.js alone is ~600 kB minified; one chunk is fine for a single-page viewer.
    chunkSizeWarningLimit: 1000,
    // The audio worklet is loaded by URL and must stay a file: a data: URL
    // is refused by AudioWorklet.addModule in some browsers.
    assetsInlineLimit: (file) => (file.endsWith("scratch-worklet.js") ? false : undefined),
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        docs: resolve(import.meta.dirname, "docs.html")
      }
    }
  }
});
