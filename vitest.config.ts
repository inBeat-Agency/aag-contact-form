import { configDefaults, defineConfig } from "vitest/config";
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
      // The erasure script is operational tooling rather than shipped code, but
      // it recomputes the Worker's subject hash — and a drifted hash deletes
      // nothing while reporting success. Its tests run in CI for exactly that
      // reason. The file carries its own `@vitest-environment node` pragma
      // because it needs `crypto.subtle`, which jsdom does not reliably provide.
      "scripts/**/*.test.ts",
    ],
    // `*.worker.test.ts` also ends in `.test.ts`, so the include above would
    // otherwise sweep it in. Those files must run in workerd, not jsdom —
    // `vitest.worker.config.ts` owns them. Spreading the defaults matters:
    // setting `exclude` replaces node_modules/dist rather than adding to them.
    exclude: [...configDefaults.exclude, "worker/**/*.worker.test.ts"],
  },
});
