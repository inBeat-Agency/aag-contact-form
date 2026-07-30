/**
 * Manual replay: POST every golden fixture to the Zapier Catch Hook as JSON.
 *
 * Run this once when setting up (or re-teaching) the Zap, so Zapier learns the
 * full field list and its mapping picker offers all 15 keys.
 *
 *   ZAPIER_HOOK_URL="https://hooks.zapier.com/hooks/catch/…" npm run zapier:samples
 *
 * The hook URL is a credential. It is read from the environment and must never
 * be hardcoded or committed.
 *
 * Heads-up on Zapier's trigger sample picker: it only surfaces the 3 most
 * recent webhooks from the past hour, so with 4 fixtures the oldest will not
 * appear in the list. That is acceptable — every fixture carries the complete
 * key set, so any single one of them teaches Zapier the whole schema. The other
 * three are there to show the backend team how each inquiry type populates it.
 *
 * This is a manual tool. It is deliberately not wired into `npm test` or CI:
 * it makes real network calls to the client's production automation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURE_NAMES = [
  "general-question",
  "consulting",
  "recruitment-hiring",
  "submit-resume",
] as const;

/** Zapier rate-limits bursts, and spacing keeps the log readable. */
const DELAY_BETWEEN_REQUESTS_MS = 2_000;

const FIXTURES_DIR = resolve(process.cwd(), "worker/fixtures");

function requireHookUrl(): string {
  const url = process.env.ZAPIER_HOOK_URL?.trim();

  if (!url) {
    console.error(
      "ZAPIER_HOOK_URL is not set.\n\n" +
        "Pass the Zapier Catch Hook URL through the environment — it is a\n" +
        "credential and must never be committed:\n\n" +
        '  ZAPIER_HOOK_URL="https://hooks.zapier.com/hooks/catch/…" npm run zapier:samples\n',
    );
    process.exit(1);
  }

  return url;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${name}.json`), "utf8"));
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<void> {
  const hookUrl = requireHookUrl();
  let failures = 0;

  console.log(`Sending ${FIXTURE_NAMES.length} fixtures to the Zapier hook…\n`);

  for (const [index, name] of FIXTURE_NAMES.entries()) {
    try {
      const response = await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(readFixture(name)),
      });

      console.log(`${name} -> HTTP ${response.status}`);
      if (!response.ok) failures += 1;
    } catch (error) {
      failures += 1;
      console.error(
        `${name} -> request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (index < FIXTURE_NAMES.length - 1) {
      await wait(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${FIXTURE_NAMES.length} fixtures failed.`);
    process.exit(1);
  }

  console.log("\nAll fixtures accepted. Note that Zapier's sample picker only");
  console.log("lists the 3 most recent webhooks from the past hour.");
}

await main();
