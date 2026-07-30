import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom gives the component suites a DOM. The schema tests are
    // environment-agnostic and pass unchanged under it.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // worker/ holds the Zapier payload contract tests. They are pure and
    // network-free, but they must run in CI or the contract silently rots.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "worker/**/*.test.ts",
    ],
  },
});
