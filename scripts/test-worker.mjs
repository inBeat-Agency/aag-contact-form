#!/usr/bin/env node
/**
 * Run the Worker suite and fail if the runtime quietly substituted itself.
 *
 * Miniflare emits this when the requested compatibility date is newer than the
 * installed workerd understands:
 *
 *   [mf:warn] The latest compatibility date supported by the installed
 *   Cloudflare Workers Runtime is "2026-03-10", but you've requested
 *   "2026-07-23". Falling back to "2026-03-10"...
 *
 * It is a warning, so the suite still exits 0 and CI reports green - while every
 * assertion was made against runtime semantics the deploy is not asking for.
 * Compatibility dates exist to change behaviour; validating the wrong set of
 * them is worse than not testing, because it looks like proof.
 *
 * So the fallback is promoted to a failure here. `wrangler.config.test.ts`
 * catches the configuration drift that usually causes it; this catches the
 * event itself, whatever the cause.
 */
import { spawn } from "node:child_process";

const FALLBACK_SIGNAL = /Falling back to "/;

const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.worker.config.ts",
    ...process.argv.slice(2),
  ],
  { stdio: ["inherit", "pipe", "pipe"] },
);

let fellBack = false;

/** Stream through untouched, so the developer sees the normal output live. */
function watch(source, sink) {
  source.on("data", (chunk) => {
    const text = chunk.toString();
    if (FALLBACK_SIGNAL.test(text)) fellBack = true;
    sink.write(text);
  });
}

watch(child.stdout, process.stdout);
watch(child.stderr, process.stderr);

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  if (fellBack) {
    process.stderr.write(
      "\nWorker suite FAILED: the Workers runtime fell back to a different " +
        "compatibility date than worker/wrangler.toml requests.\n" +
        "Every test above passed against semantics the deploy is not asking " +
        "for, so the run proves nothing.\n" +
        "Align compatibility_date with the installed workerd, or upgrade " +
        "@cloudflare/vitest-pool-workers.\n",
    );
    process.exit(1);
  }

  process.exit(0);
});
