import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Isolated runner for the Cloudflare Worker.
 *
 * WHY A SECOND CONFIG. `@cloudflare/vitest-pool-workers` does not add an
 * environment, it REPLACES the Vitest pool: every file this config collects runs
 * inside workerd instead of Node. The jsdom suites cannot survive that, so the
 * two worlds are kept in separate configs rather than in one config with two
 * projects. `vitest.config.ts` excludes `*.worker.test.ts`; this config includes
 * only those. Neither suite can accidentally collect the other's files.
 *
 * WHY THE VERSION IS PINNED TO ^0.12.0 — DO NOT "UPGRADE TO LATEST".
 * 0.12.x peers `vitest 2.0.x - 3.2.x`; 0.13.0 raised that to `^4.1.0`.
 * This repo runs vitest 2.1.9, so 0.13.0+ installs a runner that cannot load.
 * `defineWorkersConfig` is the 0.12 API; the `cloudflareTest()` plugin shown in
 * current Cloudflare docs is the Vitest 4 API and does not exist here.
 *
 * The R2 binding below is SIMULATED by Miniflare. Nothing in this file reaches
 * Cloudflare, provisions a bucket, or deploys anything.
 */
export default defineWorkersConfig({
  test: {
    include: ["worker/**/*.worker.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./worker/wrangler.toml" },
        miniflare: {
          // Test-only values. The real ones are Worker secrets and vars and are
          // never committed. Every SECRET here is deliberately fake, and the
          // secret-hygiene test asserts none of them reaches a log line.
          bindings: {
            // ALLOWED_ORIGINS is public configuration, not a secret - it is
            // literally emitted in a response header - so the two real AAG
            // origins are used verbatim. The third entry is unrelated on
            // purpose: it is what stops an implementation that hardcodes an AAG
            // hostname, or matches the substring "alphaapexgroup", from passing.
            // The padding after each comma is also deliberate; it exercises the
            // defensive parse on every single test in the file.
            ALLOWED_ORIGINS:
              "https://www.alphaapexgroup.com, https://alpha-apex-group.webflow.io, https://widget.test",
            // Deliberately NOT the host the suite posts submissions to. The
            // /resume host lock is only observable when the two differ.
            RESUME_HOST: "resume-host.test",
            // ORIGIN ONLY, and the SAME host RESUME_HOST serves.
            //
            // This value used to be "https://resume.test/resume": a different
            // host, with the /resume segment smuggled into configuration. That
            // is what hid the missing-/resume bug — the implementation appended
            // only "/<key>", the fixture supplied the rest, and the suite saw a
            // correct-looking URL that production could never produce. It also
            // meant every asserted link pointed at a host the /resume host lock
            // would have rejected. The path now comes from the Worker, and the
            // two bindings agree, so the emitted link can be fetched back.
            RESUME_URL_BASE: "https://resume-host.test",
            ZAPIER_HOOK_URL: "https://hooks.test/catch/1/abcdef",
            ZAPIER_SHARED_SECRET: "test-shared-secret-4f2a9c",
            ERASURE_SALT: "test-erasure-salt-91b7de",
          },
        },
      },
    },
  },
});
