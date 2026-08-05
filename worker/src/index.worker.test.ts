import {
  SELF,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "./index";
import { MAX_RESUME_BYTES, MAX_SUBMISSION_BODY_BYTES } from "./limits";

/**
 * Runtime tests for the Worker, executed inside workerd by
 * `@cloudflare/vitest-pool-workers` (see `vitest.worker.config.ts`).
 *
 * Miniflare simulates the R2 binding. Nothing here touches Cloudflare: no
 * bucket is provisioned, nothing is deployed, no remote call is made.
 */

declare module "cloudflare:test" {
  interface ProvidedEnv {
    RESUMES: R2Bucket;
    ALLOWED_ORIGIN: string;
    RESUME_URL_BASE: string;
    ZAPIER_HOOK_URL: string;
    ZAPIER_SHARED_SECRET: string;
    ERASURE_SALT: string;
  }
}

const ORIGIN = "https://worker.test";

/** Leading bytes real files of each accepted type actually start with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // DOCX is a ZIP container
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc
const EXE_MAGIC = [0x4d, 0x5a]; // "MZ"

/**
 * Build a File whose first bytes are real, so magic-byte checks see the truth
 * rather than a placeholder. `size` is allocated for real: the size limit is
 * enforced on measured bytes, so faking `size` would test nothing.
 */
function makeFile(
  name: string,
  type: string,
  magic: number[],
  size: number,
): File {
  const bytes = new Uint8Array(size);
  bytes.set(magic, 0);
  return new File([bytes], name, { type });
}

const validPdf = () =>
  makeFile("Jane-Doe-CV.pdf", "application/pdf", PDF_MAGIC, 2048);

/** A complete, valid Submit Resume body. Each rejection test below changes
 * exactly one attribute of this baseline, so the status it gets back is
 * attributable to that attribute and nothing else. */
function resumeSubmission(file: File | null = validPdf()): FormData {
  const form = new FormData();
  form.append("inquiryType", "Submit Resume");
  form.append("firstName", "Jane");
  form.append("lastName", "Doe");
  form.append("workEmail", "  Jane.Doe@Example.COM  ");
  form.append("message", "Please consider my application.");
  if (file) form.append("resume", file, file.name);
  return form;
}

function postForm(
  form: FormData,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/submit`, {
    method: "POST",
    body: form,
    headers,
  });
}

async function errorCodeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: string };
  return body.error ?? "<no error key>";
}

describe("POST /submit - bodyless request (deploy probe P1 contract)", () => {
  /**
   * This exact signature is load-bearing OUTSIDE the test suite. The post-deploy
   * probe asserts `400` AND `.error == "INVALID_SUBMISSION"` because that pair is
   * something only our Worker can emit — a Cloudflare Access challenge answers
   * 302, 403, 401 or HTML and fails all of them. If this response shape drifts,
   * the probe starts reporting a gated public form as healthy, which is a 100%
   * lead-loss failure shipped green. Hence its own test.
   */
  it("answers 400 with exactly {\"ok\":false,\"error\":\"INVALID_SUBMISSION\"}", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      '{"ok":false,"error":"INVALID_SUBMISSION"}',
    );
  });

  it("labels the bodyless rejection as JSON so the probe can parse it", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("CORS is scoped to /submit only", () => {
  it("answers OPTIONS /submit with 204 and the configured allowed origin", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      env.ALLOWED_ORIGIN,
    );
  });

  it("puts the allowed origin on a POST /submit response too", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      env.ALLOWED_ORIGIN,
    );
  });

  /**
   * W6. `/resume` streams candidate CVs on the origin whose session IS the
   * Access identity. Making that stream cross-origin readable would hand any
   * page the ability to read PII with the staff member's own session.
   */
  it("emits no Access-Control-Allow-Origin on a non-/submit path", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/resume/11111111-2222-4333-8444-555555555555`,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("POST /submit - server-side resume validation is authoritative", () => {
  it("rejects a file over the shared limit with 413 FILE_TOO_LARGE", async () => {
    const oversized = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES + 1,
    );
    const response = await postForm(resumeSubmission(oversized));

    expect(response.status).toBe(413);
    await expect(errorCodeOf(response)).resolves.toBe("FILE_TOO_LARGE");
  });

  it("accepts a file exactly at the limit rather than off by one", async () => {
    const atLimit = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES,
    );
    const response = await postForm(resumeSubmission(atLimit));

    expect(response.status).not.toBe(413);
    await expect(errorCodeOf(response)).resolves.not.toBe("FILE_TOO_LARGE");
  });

  it("rejects a disallowed extension with 415 UNSUPPORTED_FILE_TYPE", async () => {
    const exe = makeFile("resume.exe", "application/pdf", PDF_MAGIC, 2048);
    const response = await postForm(resumeSubmission(exe));

    expect(response.status).toBe(415);
    await expect(errorCodeOf(response)).resolves.toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects a disallowed MIME type with 415 UNSUPPORTED_FILE_TYPE", async () => {
    const spoofed = makeFile(
      "resume.pdf",
      "application/x-msdownload",
      PDF_MAGIC,
      2048,
    );
    const response = await postForm(resumeSubmission(spoofed));

    expect(response.status).toBe(415);
    await expect(errorCodeOf(response)).resolves.toBe("UNSUPPORTED_FILE_TYPE");
  });

  /**
   * The renamed-executable case from the spec. Extension and MIME both claim
   * PDF and only the bytes disagree.
   *
   * This check is a SPEED BUMP, not a safety guarantee: a malicious PDF is a
   * valid PDF and passes here. Real containment is never rendering the file
   * inline plus the Access gate on retrieval.
   */
  it("rejects a renamed executable whose bytes are not a PDF, DOC or DOCX", async () => {
    const renamedExe = makeFile(
      "resume.pdf",
      "application/pdf",
      EXE_MAGIC,
      2048,
    );
    const response = await postForm(resumeSubmission(renamedExe));

    expect(response.status).toBe(415);
    await expect(errorCodeOf(response)).resolves.toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("accepts a real DOCX (ZIP container) as a supported type", async () => {
    const docx = makeFile(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ZIP_MAGIC,
      2048,
    );
    const response = await postForm(resumeSubmission(docx));

    expect(response.status).not.toBe(415);
    await expect(errorCodeOf(response)).resolves.not.toBe(
      "UNSUPPORTED_FILE_TYPE",
    );
  });

  it("accepts a real legacy DOC (OLE2 container) as a supported type", async () => {
    const doc = makeFile("cv.doc", "application/msword", OLE2_MAGIC, 2048);
    const response = await postForm(resumeSubmission(doc));

    expect(response.status).not.toBe(415);
    await expect(errorCodeOf(response)).resolves.not.toBe(
      "UNSUPPORTED_FILE_TYPE",
    );
  });

  it("rejects a Submit Resume with no file at all as 400 INVALID_SUBMISSION", async () => {
    const response = await postForm(resumeSubmission(null));

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

  it("rejects a submission missing a required text field", async () => {
    const form = resumeSubmission();
    form.delete("workEmail");
    const response = await postForm(form);

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });
});

describe("POST /submit - Content-Length is an optimization, measured size is the gate", () => {
  /**
   * W4, and the 400-vs-413 split below is the whole point.
   *
   * Both requests carry the SAME unparseable body. The only difference is the
   * Content-Length header. If the Worker short-circuits on the header it never
   * reaches the parser and answers 413; if it parses first it answers 400. So
   * the pair proves which branch actually ran, instead of asserting that some
   * failure did not happen.
   */
  it("fast-rejects with 413 before parsing when the declared body cannot hold a valid file", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, {
      method: "POST",
      body: "this is not multipart at all",
      headers: {
        "Content-Type": "multipart/form-data; boundary=nope",
        "Content-Length": String(MAX_SUBMISSION_BODY_BYTES + 1),
      },
    });

    expect(response.status).toBe(413);
    await expect(errorCodeOf(response)).resolves.toBe("FILE_TOO_LARGE");
  });

  it("parses instead of fast-rejecting when Content-Length is not a finite number", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`, {
      method: "POST",
      body: "this is not multipart at all",
      headers: {
        "Content-Type": "multipart/form-data; boundary=nope",
        "Content-Length": "not-a-number",
      },
    });

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

  /**
   * Deliberate deviation, recorded: a MISSING Content-Length is not a rejection.
   * A legitimate chunked client would be silently refused, and silent lead loss
   * is the exact failure this whole change exists to eliminate. The measured
   * check below is what actually holds the line.
   *
   * The arithmetic asserted first is what makes this test meaningful: the
   * declared body sits UNDER the fast-path threshold, so the 413 cannot have
   * come from the header check. Only the measured file size can produce it.
   */
  it("enforces the cap on measured bytes when the declared body is under the fast-path threshold", async () => {
    const oversized = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES + 1,
    );
    const form = resumeSubmission(oversized);
    const declaredBodyBytes = (
      await new Request(`${ORIGIN}/submit`, { method: "POST", body: form })
        .arrayBuffer()
    ).byteLength;
    expect(declaredBodyBytes).toBeGreaterThan(MAX_RESUME_BYTES);
    expect(declaredBodyBytes).toBeLessThan(MAX_SUBMISSION_BODY_BYTES);

    const response = await postForm(resumeSubmission(oversized));

    expect(response.status).toBe(413);
    await expect(errorCodeOf(response)).resolves.toBe("FILE_TOO_LARGE");
  });

  /**
   * The regression this pair of thresholds exists for. A resume sent at exactly
   * the documented limit produces a body slightly OVER that limit once the
   * multipart envelope is added. Comparing the declared length to the file cap
   * rejected every one of them - a silent refusal at precisely the size the UI
   * tells candidates is allowed.
   */
  it("does not fast-reject a resume sent at exactly the documented limit", async () => {
    const atLimit = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES,
    );
    const response = await postForm(resumeSubmission(atLimit));

    expect(response.status).not.toBe(413);
  });
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Independent HMAC implementation, written from the spec rather than imported
 * from the Worker. Importing the production helper would make the assertion
 * compare a function to itself. */
async function expectedSubjectHash(email: string, salt: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(email.trim().toLowerCase()),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function storedObject() {
  const listing = await env.RESUMES.list();
  expect(listing.objects).toHaveLength(1);
  const key = listing.objects[0]!.key;
  const object = await env.RESUMES.head(key);
  expect(object).not.toBeNull();
  return { key, metadata: object!.customMetadata ?? {} };
}

describe("POST /submit - the resume is persisted to R2 before anything else", () => {
  it("stores exactly one object under an opaque UUID v4 key", async () => {
    await postForm(resumeSubmission());

    const { key } = await storedObject();
    expect(key).toMatch(UUID_V4);
  });

  /** Keys and URLs are handed to Zapier and read by staff. Putting the
   * candidate's name or file name in either turns every link into PII. */
  it("puts no part of the candidate or the file name in the key", async () => {
    await postForm(resumeSubmission());

    const { key } = await storedObject();
    for (const secret of ["jane", "doe", "cv", "pdf", "example"]) {
      expect(key.toLowerCase()).not.toContain(secret);
    }
  });

  it("keeps the original file name recoverable from object metadata", async () => {
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    expect(metadata.originalFileName).toBe("Jane-Doe-CV.pdf");
  });

  it("records submittedAt as a parseable ISO-8601 instant", async () => {
    const before = Date.now();
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    expect(metadata.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Date.parse(metadata.submittedAt!)).toBeGreaterThanOrEqual(before);
  });

  /** The join key back to the Zapier record. It is the R2 key itself, which is
   * already embedded in resumeUrl, so erasure needs no extra payload field. */
  it("records submissionId as the object's own key", async () => {
    await postForm(resumeSubmission());

    const { key, metadata } = await storedObject();
    expect(metadata.submissionId).toBe(key);
  });

  it("records subjectHash as the salted HMAC of the work email", async () => {
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    expect(metadata.subjectHash).toBe(
      await expectedSubjectHash("jane.doe@example.com", env.ERASURE_SALT),
    );
  });

  /** Erasure is driven by matching this hash, so two spellings of one address
   * must collapse to one value or a deletion request silently misses objects. */
  it("normalises case and surrounding whitespace before hashing the email", async () => {
    const form = resumeSubmission();
    form.set("workEmail", "JANE.DOE@EXAMPLE.COM   ");
    await postForm(form);

    const { metadata } = await storedObject();
    expect(metadata.subjectHash).toBe(
      await expectedSubjectHash("jane.doe@example.com", env.ERASURE_SALT),
    );
  });

  it("gives a different candidate a different subjectHash", async () => {
    const form = resumeSubmission();
    form.set("workEmail", "someone.else@example.com");
    await postForm(form);

    const { metadata } = await storedObject();
    expect(metadata.subjectHash).not.toBe(
      await expectedSubjectHash("jane.doe@example.com", env.ERASURE_SALT),
    );
  });

  it("leaks no email into the hash it stores", async () => {
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    expect(metadata.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.subjectHash?.toLowerCase()).not.toContain("jane");
  });

  it("stores nothing when validation rejects the submission", async () => {
    const exe = makeFile("resume.exe", "application/pdf", PDF_MAGIC, 2048);
    const response = await postForm(resumeSubmission(exe));

    expect(response.status).toBe(415);
    const listing = await env.RESUMES.list();
    expect(listing.objects).toHaveLength(0);
  });
});

describe("POST /submit - storage failure", () => {
  it("answers 502 STORAGE_FAILED when the R2 put rejects", async () => {
    const failingBucket = {
      put: () => Promise.reject(new Error("r2 unavailable")),
    } as unknown as R2Bucket;

    const request = new Request(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      { ...env, RESUMES: failingBucket },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("STORAGE_FAILED");
  });

  /**
   * A resume URL that points nowhere is worse than a failed submission: the
   * lead arrives, staff click the link, and the CV is simply gone. So a missing
   * RESUME_URL_BASE fails the request loudly instead of forwarding a dead link.
   */
  it("refuses to build a resume URL when RESUME_URL_BASE is unset", async () => {
    const request = new Request(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      { ...env, RESUME_URL_BASE: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("STORAGE_FAILED");
  });
});

describe("routing", () => {
  it("answers an unknown path with 404 NOT_FOUND from the fixed enum", async () => {
    const response = await SELF.fetch(`${ORIGIN}/definitely-not-a-route`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  it("answers GET /submit with 404 - /submit accepts POST and OPTIONS only", async () => {
    const response = await SELF.fetch(`${ORIGIN}/submit`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  /**
   * Ordering guarantee from the rollout plan (W3): the resume hostname is
   * pointed at this Worker and the Cloudflare Access app is created BEFORE any
   * `/resume` handler exists. Until then the route must answer 404, so the
   * hostname can never serve CV bytes before its gate exists. This test is what
   * keeps that window closed while S2 is in flight.
   */
  it("answers GET /resume/<key> with 404 - no handler ships in this slice", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/resume/11111111-2222-4333-8444-555555555555`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });
});
