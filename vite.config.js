import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative URLs so the same build works at /stratacutoscope/ and /stratacutoscope/dev/.
  base: "./",
  build: {
    // three.js alone is ~600 kB minified; one chunk is fine for a single-page viewer.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        docs: resolve(import.meta.dirname, "docs.html")
      }
    }
  }
});
