import { defineConfig } from "vite";

// The site-wide attribution tracker ships as its own tiny IIFE. Vite's library
// mode cannot emit two IIFE entries from one build, so it has its own config.
// It runs after the widget build: `emptyOutDir: false` keeps that bundle.
export default defineConfig({
  build: {
    lib: {
      entry: "src/tracker.ts",
      name: "AagAttribution",
      formats: ["iife"],
      fileName: () => "aag-attribution.js",
    },
    emptyOutDir: false,
  },
});
