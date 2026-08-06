#!/usr/bin/env node
/**
 * Erase everything stored for one candidate, on request.
 *
 * WHY THIS SCRIPT HAS TO EXIST.
 *
 * The retention decision for stored CVs is INDEFINITE BY DESIGN: they do not
 * expire, and there is deliberately no R2 lifecycle rule, because an automatic
 * expiry would delete resumes the client still needs and nobody would notice
 * until the day they went looking. Deletion is manual and happens on request.
 *
 * That decision is only defensible if the deletion is actually executable. R2
 * keys here are opaque UUIDs — chosen so a key reveals nothing about the person
 * — which means without this tool nobody can answer "delete my data" at all.
 * The retention policy and this script are one decision, not two.
 *
 *   npm run erase:candidate -- someone@example.com              # dry run
 *   npm run erase:candidate -- someone@example.com --confirm    # deletes
 *
 * DRY RUN IS THE DEFAULT. The keys are opaque, so the printed report is the only
 * review step there is: it names the filename and submission time of every
 * object that would go, which is what lets a human recognise the person they
 * meant before anything is destroyed.
 *
 * REQUIRED ENVIRONMENT — none of these have defaults and none are committed:
 *
 *   ERASURE_SALT           the Worker secret of the same name. WITHOUT THE EXACT
 *                          SAME VALUE THE WORKER SIGNED WITH, this script
 *                          computes a different hash, matches nothing, and would
 *                          report a clean erasure of zero objects. It refuses to
 *                          run rather than guess.
 *   R2_ACCOUNT_ID          Cloudflare account id
 *   R2_ACCESS_KEY_ID       R2 API token, S3 credentials
 *   R2_SECRET_ACCESS_KEY
 *
 * The bucket name is read from `worker/wrangler.toml` rather than typed here, so
 * the script cannot end up pointed at a bucket the Worker never writes to —
 * which would produce an empty listing and, again, a clean report of nothing.
 *
 * WHY THE S3 API. `wrangler r2 object` can get, put and delete a key you already
 * know, and cannot list. Finding a candidate's objects means listing the bucket
 * and reading each object's metadata, which only the S3-compatible API offers.
 * Requests are signed with `aws4fetch` — a zero-dependency SigV4 signer — rather
 * than hand-rolled, because a signing bug is a security-shaped bug.
 *
 * NOTHING HERE IS EVER IMPORTED BY THE WORKER OR THE WIDGET. It is operational
 * tooling, run by hand, and its only shared surface is the subject hash — which
 * it IMPORTS from the Worker's own module rather than reimplementing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { AwsClient } from "aws4fetch";

import { computeSubjectHash } from "../worker/src/subject-hash";

const CONFIRM_FLAG = "--confirm";

export type ParsedArguments = { email: string; confirm: boolean };

/**
 * Read the command line, or refuse it.
 *
 * An unrecognised flag is an ERROR rather than something to ignore. `--dry-run`
 * is the flag an operator would reasonably expect to exist, and ignoring it
 * while the default happens to be a dry run is luck rather than design. The day
 * someone fat-fingers `--confirmm` that luck runs out in the destructive
 * direction, so every token has to be understood or the run stops.
 */
export function parseArguments(argv: string[]): ParsedArguments {
  const flags = argv.filter((token) => token.startsWith("-"));
  const positional = argv.filter((token) => !token.startsWith("-"));

  for (const flag of flags) {
    if (flag !== CONFIRM_FLAG) {
      throw new Error(
        `Unrecognised flag "${flag}". The only flag is ${CONFIRM_FLAG}.`,
      );
    }
  }

  if (positional.length > 1) {
    throw new Error(
      `Expected exactly one candidate email, got ${positional.length}. ` +
        `Erase one person at a time so the report stays reviewable.`,
    );
  }

  const email = (positional[0] ?? "").trim();
  if (email === "") {
    throw new Error(
      `Missing the candidate email. Usage: erase-candidate <email> [${CONFIRM_FLAG}]`,
    );
  }

  return { email, confirm: flags.includes(CONFIRM_FLAG) };
}

/**
 * The salt the Worker signed with, or a refusal.
 *
 * THERE IS NO DEFAULT AND THERE MUST NEVER BE ONE. A fallback salt produces
 * well-formed digests that match nothing the Worker wrote, so the script would
 * run to completion, delete zero objects, and print a report an operator would
 * reasonably read as "this candidate had nothing stored".
 *
 * Returned RAW. The Worker signs with the binding value exactly as configured,
 * so trimming it here would compute a different digest from the same secret.
 */
export function readErasureSalt(
  env: Record<string, string | undefined>,
): string {
  const salt = env.ERASURE_SALT;
  if (salt === undefined || salt.trim() === "") {
    throw new Error(
      "ERASURE_SALT is not set. It must be the SAME value as the Worker secret " +
        "of that name: a different salt produces a different hash, so this " +
        "script would match nothing and report a clean deletion of zero " +
        "objects while every CV is still stored. Refusing to run.",
    );
  }
  return salt;
}

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * The S3 credentials, with every missing one named at once.
 *
 * Reported together rather than one per run: an operator handling a deletion
 * request should not have to discover three missing variables across three
 * attempts, each of which looks like a different failure.
 */
export function readR2Credentials(
  env: Record<string, string | undefined>,
): R2Credentials {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ] as const;

  const missing = required.filter(
    (name) => (env[name] ?? "").trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing R2 credentials: ${missing.join(", ")}. ` +
        `Create an R2 API token with object read and delete on the bucket.`,
    );
  }

  return {
    accountId: env.R2_ACCOUNT_ID!.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
  };
}

/**
 * The bucket the Worker writes to, read from the Worker's own deploy config.
 *
 * Not a literal in this file. A literal can be right on the day it is typed and
 * wrong after the next config change, and being wrong here means listing an
 * empty bucket and reporting a clean erasure of nothing.
 */
export function bucketNameFrom(wranglerToml: string): string {
  const match = /^\s*bucket_name\s*=\s*"([^"]+)"/m.exec(wranglerToml);
  if (match === null) {
    throw new Error(
      "No bucket_name found in worker/wrangler.toml. Refusing to guess which " +
        "bucket holds the resumes.",
    );
  }
  return match[1]!;
}

export type Listing = { keys: string[]; continuationToken: string | null };

/**
 * Pull the keys and the paging token out of a ListObjectsV2 response.
 *
 * Regex rather than an XML parser, deliberately: this reads two element types
 * from one well-known response shape, and adding a parser dependency to do it
 * would be a larger surface than the thing it replaces. Keys in this bucket are
 * UUIDs generated by `crypto.randomUUID()`, so they contain nothing that needs
 * entity decoding — the decode below is defence against a future key scheme
 * rather than something today's data requires.
 */
export function parseListing(xml: string): Listing {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    decodeXmlText(match[1]!),
  );
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
    xml,
  );

  return {
    keys,
    continuationToken: token === null ? null : decodeXmlText(token[1]!),
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The subject hash on a stored object, or null when it carries none.
 *
 * READ CASE-INSENSITIVELY, AND THAT IS NOT DEFENSIVE PROGRAMMING. The Worker
 * stores the metadata key as `subjectHash`; the S3 API returns it lowercased as
 * `x-amz-meta-subjecthash`. Looking it up with the name the Worker used finds
 * nothing on every single object — and the failure surfaces as "this candidate
 * has nothing stored", which is indistinguishable from the truth.
 *
 * `Headers` already matches names case-insensitively, so this is one lookup; the
 * comment exists because the reason is not visible from the code.
 */
export function subjectHashOf(headers: Headers): string | null {
  const value = headers.get("x-amz-meta-subjecthash");
  return value === null || value.trim() === "" ? null : value.trim();
}

export type StoredObjectMetadata = {
  key: string;
  subjectHash: string;
  originalFileName: string;
  submittedAt: string;
};

/** Shown when the stored value is absent — visibly not a filename, so it cannot
 * be mistaken for one by an operator skim-reading the report. */
const UNKNOWN = "<unknown>";

export function readObjectMetadata(
  key: string,
  headers: Headers,
): StoredObjectMetadata {
  return {
    key,
    subjectHash: subjectHashOf(headers) ?? "",
    originalFileName:
      headers.get("x-amz-meta-originalfilename")?.trim() || UNKNOWN,
    submittedAt: headers.get("x-amz-meta-submittedat")?.trim() || UNKNOWN,
  };
}

/** One reviewable line per object. The key alone is a UUID and tells a human
 * nothing; the filename and time are what identify the person. */
export function describeMatch(metadata: StoredObjectMetadata): string {
  return `  ${metadata.key}  ${metadata.submittedAt}  ${metadata.originalFileName}`;
}

export type Outcome = { exitCode: number; message: string };

/**
 * What to print and what to exit with.
 *
 * ZERO MATCHES IS A FAILURE. It has exactly two causes and this script cannot
 * tell them apart: the candidate genuinely has nothing stored, or this script
 * and the Worker disagree about the hash and every CV is still sitting in the
 * bucket. Exiting 0 with "0 objects deleted" invites both a human and any
 * automation to file the request as honoured. It is the same silent success
 * this project has been burned by three times, so it exits non-zero and says
 * which two things it could mean.
 */
export function reportOutcome(input: {
  matchCount: number;
  confirm: boolean;
}): Outcome {
  if (input.matchCount === 0) {
    return {
      exitCode: 1,
      message:
        "NO MATCH — nothing was deleted.\n" +
        "This means either that this candidate has nothing stored, or that " +
        "ERASURE_SALT does not match the value the Worker signed with. This " +
        "script cannot tell those apart, so it will not report success. " +
        "Verify the salt before recording the request as honoured.",
    };
  }

  if (!input.confirm) {
    return {
      exitCode: 0,
      message:
        `DRY RUN — ${input.matchCount} object(s) listed above WOULD be deleted. ` +
        `Nothing has been changed. Re-run with ${CONFIRM_FLAG} to delete them.`,
    };
  }

  return {
    exitCode: 0,
    message: `Deleted ${input.matchCount} object(s). This cannot be undone.`,
  };
}

/** Every key in the bucket, following continuation tokens to the end. */
async function listAllKeys(
  client: AwsClient,
  endpoint: string,
  bucket: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | null = null;

  do {
    const url = new URL(`${endpoint}/${bucket}`);
    url.searchParams.set("list-type", "2");
    if (continuationToken !== null) {
      url.searchParams.set("continuation-token", continuationToken);
    }

    const response = await client.fetch(url.toString());
    if (!response.ok) {
      throw new Error(
        `Listing ${bucket} failed with HTTP ${response.status}. No objects ` +
          `were deleted.`,
      );
    }

    const listing = parseListing(await response.text());
    keys.push(...listing.keys);
    continuationToken = listing.continuationToken;
  } while (continuationToken !== null);

  return keys;
}

/**
 * The objects belonging to this subject.
 *
 * One HEAD per key, because ListObjectsV2 does not return custom metadata. That
 * is O(objects in the bucket) requests and it is the honest cost of an opaque
 * key scheme — the alternative is an index that would itself be PII.
 *
 * A HEAD that fails is thrown rather than skipped. Skipping would silently
 * shrink the match set, and a partial erasure reported as complete is worse
 * than a failed one.
 */
async function findMatches(
  client: AwsClient,
  endpoint: string,
  bucket: string,
  keys: string[],
  subjectHash: string,
): Promise<StoredObjectMetadata[]> {
  const matches: StoredObjectMetadata[] = [];

  for (const key of keys) {
    const response = await client.fetch(
      `${endpoint}/${bucket}/${encodeURIComponent(key)}`,
      { method: "HEAD" },
    );
    if (!response.ok) {
      throw new Error(
        `Reading metadata for ${key} failed with HTTP ${response.status}. ` +
          `No objects were deleted — a partial match set would under-report ` +
          `what this candidate still has stored.`,
      );
    }

    if (subjectHashOf(response.headers) === subjectHash) {
      matches.push(readObjectMetadata(key, response.headers));
    }
  }

  return matches;
}

async function deleteMatches(
  client: AwsClient,
  endpoint: string,
  bucket: string,
  matches: StoredObjectMetadata[],
): Promise<void> {
  for (const match of matches) {
    const response = await client.fetch(
      `${endpoint}/${bucket}/${encodeURIComponent(match.key)}`,
      { method: "DELETE" },
    );
    // R2 answers 204 for a delete. Anything else is reported with the key, so a
    // partially completed erasure names exactly what is left.
    if (!response.ok) {
      throw new Error(
        `Deleting ${match.key} failed with HTTP ${response.status}. Some ` +
          `objects may already have been deleted; re-run to see what remains.`,
      );
    }
  }
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const { email, confirm } = parseArguments(argv);
  const salt = readErasureSalt(env);
  const credentials = readR2Credentials(env);
  const bucket = bucketNameFrom(
    readFileSync(join(process.cwd(), "worker", "wrangler.toml"), "utf8"),
  );

  const subjectHash = await computeSubjectHash(email, salt);
  const endpoint = `https://${credentials.accountId}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  // The address itself is never printed back. It is the PII this whole scheme
  // exists to keep out of stored metadata, and an operator's terminal scrollback
  // is not a better place for it than an object header.
  console.log(`Bucket:       ${bucket}`);
  console.log(`Subject hash: ${subjectHash}`);
  console.log(confirm ? "Mode:         DELETE" : "Mode:         DRY RUN");
  console.log("");

  const keys = await listAllKeys(client, endpoint, bucket);
  const matches = await findMatches(
    client,
    endpoint,
    bucket,
    keys,
    subjectHash,
  );

  if (matches.length > 0) {
    console.log(`Matched ${matches.length} of ${keys.length} stored object(s):`);
    console.log("  key                                   submittedAt               originalFileName");
    for (const match of matches) console.log(describeMatch(match));
    console.log("");
  }

  if (confirm && matches.length > 0) {
    await deleteMatches(client, endpoint, bucket, matches);
  }

  const outcome = reportOutcome({ matchCount: matches.length, confirm });
  console.log(outcome.message);
  return outcome.exitCode;
}

/**
 * Only run when invoked as a command. The test suite imports this module for its
 * pure parts, and a module that erases candidate data on import would be a
 * remarkable way to lose a bucket.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2), process.env)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Erasure failed.",
      );
      process.exitCode = 1;
    });
}
