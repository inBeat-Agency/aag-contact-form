// @vitest-environment node
//
// Node, not jsdom. This exercises `crypto.subtle` and `node:fs`, and the jsdom
// environment does not reliably provide the first.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeSubjectHash } from "../worker/src/subject-hash";
import {
  bucketNameFrom,
  describeMatch,
  parseArguments,
  parseListing,
  readErasureSalt,
  readObjectMetadata,
  readR2Credentials,
  reportOutcome,
  subjectHashOf,
} from "./erase-candidate";

/**
 * THE ANTI-DRIFT PIN, AND IT IS THE REASON THIS FILE EXISTS.
 *
 * The erasure script finds a candidate's objects by recomputing the hash the
 * Worker stored on them. If those two computations ever disagree, the script
 * matches nothing, reports "0 objects", and a deletion request is recorded as
 * honoured while every CV is still in the bucket. That is a silent success on
 * a legal obligation, and it is the third time this repo has had to design
 * specifically against a wrong value that looked right.
 *
 * The digest below was NOT produced by the code under test. It was computed
 * with `node:crypto`'s `createHmac` — a different implementation, in a
 * different runtime, from the WebCrypto `subtle.sign` the Worker and the script
 * both use:
 *
 *   crypto.createHmac("sha256", "test-erasure-salt-91b7de")
 *         .update("jane.doe@example.com", "utf8").digest("hex")
 *
 * `worker/src/index.worker.test.ts` pins the SAME literal against the value the
 * Worker actually writes into R2 metadata. Neither side derives it from the
 * other and neither derives it from the production formula, so the two can only
 * stay green together while the script and the Worker still agree.
 *
 * The salt and address are the ones the worker suite binds and submits, so the
 * two pins describe the same fact rather than two unrelated ones.
 */
const KNOWN_SALT = "test-erasure-salt-91b7de";
const KNOWN_DIGEST =
  "b69ad1bda66ba89c297fcc4477d8758c6499d0f6b393b3cce168d68b25a07013";

describe("erase-candidate: the subject hash", () => {
  /**
   * The single assertion that stops silent drift.
   *
   * The input is the address AS A CANDIDATE TYPED IT — mixed case, padded with
   * whitespace — because normalisation is the part most likely to drift and the
   * part whose drift is invisible. Drop the `.trim()` and this digest becomes
   * 7fd36e43…; drop the `.toLowerCase()` and it becomes f4f25030…. Neither is
   * the literal below, so either edit turns this red instead of quietly
   * deleting nothing.
   */
  it("reproduces the Worker's digest for an address as a candidate typed it", async () => {
    await expect(
      computeSubjectHash("  Jane.Doe@Example.COM  ", KNOWN_SALT),
    ).resolves.toBe(KNOWN_DIGEST);
  });

  /**
   * DO NOT DELETE THIS AS REDUNDANT WITH THE WORKER SUITE. IT IS NOT.
   *
   * Mutation testing found this while the suite was being written: removing the
   * `.trim()` from `computeSubjectHash` leaves the ENTIRE worker suite green.
   * The Worker reaches the hash through `readText()`, which already trims, and
   * `parseArguments()` on this side trims too — so neither caller exercises the
   * normalisation the shared function promises, and neither suite's end-to-end
   * paths can see it disappear.
   *
   * These assertions call the shared function DIRECTLY with padded input, which
   * is the only place that promise is actually tested. A future caller that
   * passes a raw address — a metadata backfill, a second tool, an operator
   * pasting from an email client into something other than argv — would
   * silently hash the wrong string, and the objects it failed to match would be
   * reported as "this candidate has nothing stored".
   */
  it("collapses every spelling of one address onto one digest", async () => {
    const spellings = [
      "jane.doe@example.com",
      "JANE.DOE@EXAMPLE.COM",
      "  Jane.Doe@Example.COM  ",
      "\tjane.doe@EXAMPLE.com\n",
    ];

    const digests = await Promise.all(
      spellings.map((spelling) => computeSubjectHash(spelling, KNOWN_SALT)),
    );

    expect(digests).toEqual(spellings.map(() => KNOWN_DIGEST));
  });

  /**
   * The salt has to matter. A digest that ignored it would still look like a
   * hash, still be 64 hex characters, and still match itself — while being
   * reversible by anyone who can guess an address.
   */
  it("produces a different digest under a different salt", async () => {
    await expect(
      computeSubjectHash("jane.doe@example.com", "a-different-salt"),
    ).resolves.not.toBe(KNOWN_DIGEST);
  });
});

describe("erase-candidate: refusing to run unconfigured", () => {
  /**
   * NO DEFAULT SALT, EVER.
   *
   * A default would hash every address under a value that is not the one the
   * Worker used, so the script would run happily, match nothing, and report a
   * clean deletion of zero objects. Refusing loudly is the only outcome that
   * cannot be mistaken for success.
   */
  it("refuses without ERASURE_SALT rather than hashing under something else", () => {
    expect(() => readErasureSalt({})).toThrow(/ERASURE_SALT/);
    expect(() => readErasureSalt({ ERASURE_SALT: "" })).toThrow(/ERASURE_SALT/);
    expect(() => readErasureSalt({ ERASURE_SALT: "   " })).toThrow(
      /ERASURE_SALT/,
    );
  });

  /** The success signal: a configured salt is returned verbatim, not trimmed
   * into something else. The Worker signs with the raw binding value. */
  it("returns the configured salt exactly as it was given", () => {
    expect(readErasureSalt({ ERASURE_SALT: KNOWN_SALT })).toBe(KNOWN_SALT);
  });

  it("names every missing R2 credential instead of failing at the first request", () => {
    expect(() => readR2Credentials({})).toThrow(/R2_ACCOUNT_ID/);
    expect(() =>
      readR2Credentials({
        R2_ACCOUNT_ID: "acct",
        R2_SECRET_ACCESS_KEY: "secret",
      }),
    ).toThrow(/R2_ACCESS_KEY_ID/);

    expect(
      readR2Credentials({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
  });
});

describe("erase-candidate: the command line", () => {
  /**
   * DRY RUN IS THE DEFAULT AND DELETION IS OPT-IN.
   *
   * This command destroys candidate PII permanently and R2 keys are opaque
   * UUIDs, so there is no way to eyeball the blast radius beforehand — the
   * report IS the review step. A tool that deletes on its default invocation
   * gives the operator nothing to review.
   */
  it("defaults to a dry run and deletes only when --confirm is passed", () => {
    expect(parseArguments(["jane@example.com"])).toEqual({
      email: "jane@example.com",
      confirm: false,
    });
    expect(parseArguments(["jane@example.com", "--confirm"])).toEqual({
      email: "jane@example.com",
      confirm: true,
    });
    expect(parseArguments(["--confirm", "jane@example.com"])).toEqual({
      email: "jane@example.com",
      confirm: true,
    });
  });

  /**
   * An unrecognised flag is refused rather than ignored. `--dry-run` is the
   * flag an operator would reasonably expect to exist; silently ignoring it
   * while the real default happens to match is luck, not design, and the day
   * someone types `--confirmm` that luck runs out in the destructive direction.
   */
  it("refuses an unrecognised flag instead of ignoring it", () => {
    expect(() => parseArguments(["jane@example.com", "--dry-run"])).toThrow(
      /--dry-run/,
    );
    expect(() => parseArguments(["jane@example.com", "--confirmm"])).toThrow(
      /--confirmm/,
    );
  });

  it("refuses no address, an empty address, and more than one address", () => {
    expect(() => parseArguments([])).toThrow(/email/i);
    expect(() => parseArguments(["   "])).toThrow(/email/i);
    expect(() => parseArguments(["a@example.com", "b@example.com"])).toThrow(
      /one/i,
    );
  });
});

describe("erase-candidate: reading the bucket", () => {
  /**
   * THE BUCKET NAME COMES FROM THE WORKER'S OWN DEPLOY CONFIG.
   *
   * A literal here could point at a bucket the Worker never writes to, and the
   * script would then list an empty bucket, match nothing, and report a clean
   * erasure of zero objects — the same silent success the hash pin above
   * exists to prevent, arriving through a different door.
   */
  it("reads the bucket name out of the Worker's deploy config", () => {
    expect(
      bucketNameFrom(
        ['[[r2_buckets]]', 'binding = "RESUMES"', 'bucket_name = "some-bucket"'].join(
          "\n",
        ),
      ),
    ).toBe("some-bucket");
  });

  it("refuses a config with no bucket rather than guessing one", () => {
    expect(() => bucketNameFrom("name = \"aag-contact-form-worker\"")).toThrow(
      /bucket_name/,
    );
  });

  /**
   * The literal is typed out by hand, deliberately, and compared against the
   * file that actually ships. This is the only assertion that can see the
   * script and the Worker pointed at two different buckets.
   */
  it("targets the same bucket the Worker writes to", () => {
    const deployConfig = readFileSync(
      join(process.cwd(), "worker", "wrangler.toml"),
      "utf8",
    );

    expect(bucketNameFrom(deployConfig)).toBe("aag-resumes");
  });

  it("reads keys and the continuation token out of a ListObjectsV2 response", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<ListBucketResult>",
      "<Contents><Key>0188d318-f23d-4822-8bf0-8ee0a0c0cdc5</Key></Contents>",
      "<Contents><Key>9c1f0f7a-6c1e-4a2b-9d33-2f5b7c8e1a04</Key></Contents>",
      "<IsTruncated>true</IsTruncated>",
      "<NextContinuationToken>tok-123</NextContinuationToken>",
      "</ListBucketResult>",
    ].join("");

    expect(parseListing(xml)).toEqual({
      keys: [
        "0188d318-f23d-4822-8bf0-8ee0a0c0cdc5",
        "9c1f0f7a-6c1e-4a2b-9d33-2f5b7c8e1a04",
      ],
      continuationToken: "tok-123",
    });
  });

  it("reports no continuation token when the listing is complete", () => {
    const xml =
      "<ListBucketResult><Contents><Key>only-one</Key></Contents>" +
      "<IsTruncated>false</IsTruncated></ListBucketResult>";

    expect(parseListing(xml)).toEqual({
      keys: ["only-one"],
      continuationToken: null,
    });
  });
});

describe("erase-candidate: matching stored objects", () => {
  function headersFor(values: Record<string, string>): Headers {
    return new Headers(values);
  }

  /**
   * S3 RETURNS CUSTOM METADATA KEYS LOWERCASED.
   *
   * The Worker stores `subjectHash`; the S3 API hands it back as
   * `x-amz-meta-subjecthash`. A case-sensitive lookup for the name the Worker
   * used finds nothing on every object and the script reports a clean erasure
   * of zero. The lookup is therefore case-insensitive, and this test drives
   * both spellings so the property is proved rather than assumed.
   */
  it("reads the subject hash whatever case the API returns the header in", () => {
    expect(
      subjectHashOf(headersFor({ "x-amz-meta-subjecthash": KNOWN_DIGEST })),
    ).toBe(KNOWN_DIGEST);
    expect(
      subjectHashOf(headersFor({ "X-Amz-Meta-SubjectHash": KNOWN_DIGEST })),
    ).toBe(KNOWN_DIGEST);
  });

  it("reports an object with no subject hash as unmatchable rather than matching", () => {
    expect(subjectHashOf(headersFor({}))).toBeNull();
    expect(subjectHashOf(headersFor({ "x-amz-meta-submittedat": "x" }))).toBeNull();
  });

  /**
   * The operator has to be able to sanity-check the list before confirming,
   * and an opaque UUID tells them nothing. The filename and the submission
   * time are what let a human recognise the person they meant to erase.
   */
  it("describes a match with the key, the original filename and the submission time", () => {
    const metadata = readObjectMetadata(
      "0188d318-f23d-4822-8bf0-8ee0a0c0cdc5",
      headersFor({
        "x-amz-meta-subjecthash": KNOWN_DIGEST,
        "x-amz-meta-originalfilename": "Jane-Doe-CV.pdf",
        "x-amz-meta-submittedat": "2026-08-05T00:00:00.000Z",
      }),
    );

    expect(metadata).toEqual({
      key: "0188d318-f23d-4822-8bf0-8ee0a0c0cdc5",
      subjectHash: KNOWN_DIGEST,
      originalFileName: "Jane-Doe-CV.pdf",
      submittedAt: "2026-08-05T00:00:00.000Z",
    });

    const line = describeMatch(metadata);
    expect(line).toContain("0188d318-f23d-4822-8bf0-8ee0a0c0cdc5");
    expect(line).toContain("Jane-Doe-CV.pdf");
    expect(line).toContain("2026-08-05T00:00:00.000Z");
  });

  /**
   * A missing filename must not read as a real one. `<unknown>` is visibly not
   * a filename; an empty column is a blank a tired operator fills in from
   * memory.
   */
  it("marks absent metadata visibly instead of rendering a blank column", () => {
    const metadata = readObjectMetadata(
      "key-with-no-metadata",
      headersFor({ "x-amz-meta-subjecthash": KNOWN_DIGEST }),
    );

    expect(metadata.originalFileName).toBe("<unknown>");
    expect(metadata.submittedAt).toBe("<unknown>");
  });
});

describe("erase-candidate: the outcome", () => {
  /**
   * "0 OBJECTS DELETED" MUST NEVER READ AS SUCCESS.
   *
   * Zero matches has exactly two causes, and one of them is catastrophic: the
   * candidate genuinely has nothing stored, or the script and the Worker
   * disagree about the hash and the CVs are still sitting there. The script
   * cannot tell those apart, so it must refuse to claim the first — a non-zero
   * exit is what stops an automated caller, or a person skim-reading, from
   * filing the request as honoured.
   */
  it("treats zero matches as a failure, in dry run and after --confirm alike", () => {
    const dryRun = reportOutcome({ matchCount: 0, confirm: false });
    const confirmed = reportOutcome({ matchCount: 0, confirm: true });

    expect([dryRun.exitCode, confirmed.exitCode]).toEqual([1, 1]);
    for (const outcome of [dryRun, confirmed]) {
      expect(outcome.message).toMatch(/nothing was deleted/i);
    }
  });

  it("succeeds on a dry run that found objects, and says they were not deleted", () => {
    const outcome = reportOutcome({ matchCount: 3, confirm: false });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toMatch(/dry run/i);
    expect(outcome.message).toMatch(/--confirm/);
    expect(outcome.message).toMatch(/3/);
  });

  it("succeeds on a confirmed run and reports the count it deleted", () => {
    const outcome = reportOutcome({ matchCount: 2, confirm: true });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toMatch(/deleted 2/i);
    expect(outcome.message).not.toMatch(/dry run/i);
  });
});
