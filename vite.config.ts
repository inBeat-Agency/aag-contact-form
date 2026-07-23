import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

// The widget ships as a single self-mounting IIFE bundle. CSS is injected at
// runtime by JS, so Webflow only needs one <script> tag and one mount div.
export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  // Library mode leaves process.env.* references for consuming applications.
  // This standalone browser IIFE has no consumer build step or Node globals.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/main.tsx",
      name: "AagContactForm",
      formats: ["iife"],
      fileName: () => "aag-contact-form.js",
    },
    rollupOptions: {
      output: {
        // Keep everything in one file; do not split chunks.
        inlineDynamicImports: true,
      },
    },
    // React + ReactDOM are bundled in so the widget is fully standalone.
    cssCodeSplit: false,
  },
});
