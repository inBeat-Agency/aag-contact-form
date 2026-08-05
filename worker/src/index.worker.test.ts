import {
  SELF,
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildFormData } from "../../src/submit";
import type { ContactFormFields } from "../../src/schema";
import consulting from "../fixtures/consulting.json";
import generalQuestion from "../fixtures/general-question.json";
import recruitmentHiring from "../fixtures/recruitment-hiring.json";
import submitResume from "../fixtures/submit-resume.json";
import worker from "./index";
import {
  INQUIRY_TYPES,
  MAX_FILE_NAME_BYTES,
  MAX_RESUME_BYTES,
  MAX_SUBMISSION_BODY_BYTES,
  MAX_TEXT_FIELD_BYTES,
  MAX_TEXT_FIELD_CHARS,
  MAX_TEXT_FIELD_COUNT,
  MAX_TEXT_PAYLOAD_BYTES,
  requiredTextFieldsFor,
} from "./limits";
import type { ZapierPayload } from "./payload";

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

const ZAPIER_ORIGIN = "https://hooks.test";
const ZAPIER_PATH = "/catch/1/abcdef";

type CapturedForward = {
  body?: string;
  headers?: Record<string, string>;
};

/**
 * Intercept the single outbound call and capture what was actually sent.
 *
 * Activated for the WHOLE file, not per describe. `disableNetConnect` makes any
 * unmatched request throw, so a test that forgets to mock Zapier fails loudly
 * instead of quietly reaching the real network and passing for the wrong reason.
 */
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

function interceptZapier(status = 200, replyBody = '{"status":"success"}') {
  const captured: CapturedForward = {};
  fetchMock
    .get(ZAPIER_ORIGIN)
    .intercept({ path: ZAPIER_PATH, method: "POST" })
    .reply(status, (options) => {
      captured.body = options.body as string;
      captured.headers = options.headers as Record<string, string>;
      return replyBody;
    });
  return captured;
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

  /** Asserted as a full 200, not as "did not 413". A rejection-only suite is
   * satisfied by an implementation that refuses everything. */
  it("accepts a file of exactly the limit end to end", async () => {
    interceptZapier();
    const atLimit = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES,
    );
    const response = await postForm(resumeSubmission(atLimit));

    expect(response.status).toBe(200);
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

  it("accepts a real DOCX (ZIP container) end to end", async () => {
    interceptZapier();
    const docx = makeFile(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ZIP_MAGIC,
      2048,
    );
    const response = await postForm(resumeSubmission(docx));

    expect(response.status).toBe(200);
  });

  it("accepts a real legacy DOC (OLE2 container) end to end", async () => {
    interceptZapier();
    const doc = makeFile("cv.doc", "application/msword", OLE2_MAGIC, 2048);
    const response = await postForm(resumeSubmission(doc));

    expect(response.status).toBe(200);
  });

  /**
   * A file with no reported MIME type is common on some operating systems, and
   * multipart re-encodes that empty type as `application/octet-stream`. So the
   * widget validates "" and the Worker receives "application/octet-stream" for
   * the identical file. Refusing it server-side accepts the upload in the form
   * and then drops it - silent lead loss for a whole class of users.
   */
  it("accepts a file whose MIME type the browser could not determine", async () => {
    interceptZapier();
    const untyped = makeFile("cv.pdf", "", PDF_MAGIC, 2048);
    const response = await postForm(resumeSubmission(untyped));

    expect(response.status).toBe(200);
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

/**
 * A complete, accepted submission for each inquiry type, built from the shared
 * contract rather than from a hand-written list, so a new required field cannot
 * be added to the schema without these baselines noticing.
 */
function completeSubmission(inquiryType: string): FormData {
  const form = new FormData();
  form.append("inquiryType", inquiryType);
  form.append("firstName", "Jane");
  form.append("lastName", "Doe");
  form.append("workEmail", "jane.doe@example.com");
  form.append("message", "Please get in touch about this.");
  for (const field of requiredTextFieldsFor(inquiryType) ?? []) {
    if (form.get(field) === null) form.append(field, `${field}-value`);
  }
  if (inquiryType === "Submit Resume") {
    const file = validPdf();
    form.append("resume", file, file.name);
  }
  return form;
}

describe("POST /submit - the inquiry contract is enforced server-side", () => {
  /**
   * W2. Server-side validation checked five common fields for non-emptiness and
   * stopped there, so `inquiryType: "Bogus"` with `workEmail: "not-an-email"`
   * was stored, forwarded and answered 200 - a lead nobody can reply to, filed
   * under a category no Zap branch matches.
   *
   * The requirements live in `worker/src/limits.ts` and the widget's schema is
   * built from the same table. A field that is required in one place and
   * optional in the other is the divergence that accepts a submission in the
   * form and then drops it at the server.
   */
  it.each(INQUIRY_TYPES)("accepts a complete %s submission", async (type) => {
    interceptZapier();

    const response = await postForm(completeSubmission(type));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  const REMOVALS: [string, string][] = INQUIRY_TYPES.flatMap((type) =>
    (requiredTextFieldsFor(type) ?? []).map(
      (field) => [type, field] as [string, string],
    ),
  );

  it.each(REMOVALS)(
    "refuses a %s submission with %s removed",
    async (type, field) => {
      const form = completeSubmission(type);
      form.delete(field);

      const response = await postForm(form);

      expect(response.status).toBe(400);
      await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
    },
  );

  it.each(["Bogus", "", "submit resume", "SUBMIT RESUME"])(
    "refuses the unknown inquiry type %p",
    async (type) => {
      const form = completeSubmission("Consulting");
      form.set("inquiryType", type);

      const response = await postForm(form);

      expect(response.status).toBe(400);
      await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
    },
  );

  /**
   * Surrounding whitespace is trimmed rather than rejected. The discriminator
   * has to match a Zap branch exactly, but a stray space arriving from a
   * copy-paste is not a reason to throw a real lead away.
   */
  it("accepts an inquiry type carrying surrounding whitespace", async () => {
    interceptZapier();
    const form = completeSubmission("Consulting");
    form.set("inquiryType", "  Consulting  ");

    const response = await postForm(form);

    expect(response.status).toBe(200);
  });

  it.each(["not-an-email", "jane.doe@", "@example.com", "jane doe@x.com", "jane@example"])(
    "refuses the unusable work email %p",
    async (email) => {
      const form = completeSubmission("General Question");
      form.set("workEmail", email);

      const response = await postForm(form);

      expect(response.status).toBe(400);
      await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
    },
  );

  /**
   * The rejection tests above are all satisfied by an implementation that
   * refuses everything, so the accepted set is asserted too - and deliberately
   * includes the shapes a stricter regex would wrongly throw away. Refusing a
   * real candidate is the failure mode this project is named after.
   */
  it.each([
    "jane.doe@example.com",
    "jane+tag@example.co.uk",
    "j@sub.domain.example.com",
    "jane_doe-99@example-corp.com",
    "JANE.DOE@EXAMPLE.COM",
  ])("accepts the deliverable work email %p", async (email) => {
    interceptZapier();
    const form = completeSubmission("General Question");
    form.set("workEmail", email);

    const response = await postForm(form);

    expect(response.status).toBe(200);
  });
});

describe("the 10MB limit is a published promise, not whatever the constant says", () => {
  /**
   * W1. Every other boundary test in this file builds its input from
   * `MAX_RESUME_BYTES`, so it asserts that the Worker agrees with itself and
   * nothing more. Change the constant to 1 MB and all of them stay green while
   * the form still tells candidates 10MB and the server starts refusing at one
   * tenth of it - silent lead loss, shipped by a fully green suite.
   *
   * So this literal is deliberately NOT imported. It is the number in the UI
   * copy, written out again, and the only test here that can notice the two
   * drifting apart.
   */
  const TEN_MEGABYTES = 10 * 1024 * 1024;

  it("still defines the shared limit as exactly 10MB", () => {
    expect(MAX_RESUME_BYTES).toBe(TEN_MEGABYTES);
  });

  it("delivers a resume of exactly 10485760 bytes end to end", async () => {
    interceptZapier();
    const atPromise = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      TEN_MEGABYTES,
    );

    const response = await postForm(resumeSubmission(atPromise));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("refuses a resume one byte over 10485760", async () => {
    const overPromise = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      TEN_MEGABYTES + 1,
    );

    const response = await postForm(resumeSubmission(overPromise));

    expect(response.status).toBe(413);
    await expect(errorCodeOf(response)).resolves.toBe("FILE_TOO_LARGE");
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
  it("delivers a resume sent at exactly the documented limit", async () => {
    interceptZapier();
    const atLimit = makeFile(
      "Jane-Doe-CV.pdf",
      "application/pdf",
      PDF_MAGIC,
      MAX_RESUME_BYTES,
    );
    const response = await postForm(resumeSubmission(atLimit));

    expect(response.status).toBe(200);
  });
});

/** 4-byte code points: the worst case a UTF-8 text field can weigh per char. */
function maximalText(bytes: number): string {
  return "\u{1F600}".repeat(Math.floor(bytes / 4));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The heaviest submission that still satisfies every declared field and file
 * rule: every text field at its cap, the longest permitted file name, and a
 * resume of exactly the documented maximum.
 */
function maximalValidSubmission(): FormData {
  const form = new FormData();
  form.append("inquiryType", "Consulting");
  for (const field of ["firstName", "lastName", "title", "company", "phone", "message"]) {
    form.append(field, maximalText(MAX_TEXT_FIELD_BYTES));
  }
  const local = "a".repeat(MAX_TEXT_FIELD_BYTES - "@example.com".length);
  form.append("workEmail", `${local}@example.com`);
  form.append("companySize", "51-200");
  form.append("estimatedBudget", "$50K – $150K");
  form.append("expectedTimeline", "ASAP");
  form.append("source", "aag-contact-form");
  form.append("website", "");

  const name = `${"n".repeat(MAX_FILE_NAME_BYTES - ".pdf".length)}.pdf`;
  const file = makeFile(name, "application/pdf", PDF_MAGIC, MAX_RESUME_BYTES);
  form.append("resume", file, file.name);
  return form;
}

describe("a submission that satisfies every rule is NEVER refused", () => {
  /**
   * W3. `MAX_SUBMISSION_BODY_BYTES` was `MAX_RESUME_BYTES + 1MB`, which is not a
   * bound on anything: text fields had no maximum length, so a 4-byte PDF next
   * to a 12MB message came back `413 FILE_TOO_LARGE` while the measured file was
   * three orders of magnitude under the cap. The pre-parse fast path could
   * therefore refuse a request the declared rules said was fine, and silent
   * refusal of a valid lead is this project's defining failure.
   *
   * The ceiling is now DERIVED from limits that are actually enforced, and the
   * proof below is measured rather than argued: the heaviest legal submission is
   * encoded, weighed, and required to sit under the ceiling AND come back 200.
   */
  it("keeps the declared ceiling above the heaviest legal submission", async () => {
    const encoded = await new Request(`${ORIGIN}/submit`, {
      method: "POST",
      body: maximalValidSubmission(),
    }).arrayBuffer();

    expect(encoded.byteLength).toBeGreaterThan(MAX_RESUME_BYTES);
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_SUBMISSION_BODY_BYTES);
  });

  it("delivers the heaviest legal submission end to end", async () => {
    interceptZapier();

    const response = await postForm(maximalValidSubmission());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  /**
   * The other half: the limits that make the ceiling provable have to be real.
   * An unbounded text field is what made the old ceiling a fiction.
   */
  it("refuses a text field one byte over its cap as an INVALID submission", async () => {
    const form = completeSubmission("General Question");
    form.set("message", `${maximalText(MAX_TEXT_FIELD_BYTES)}x`);

    const response = await postForm(form);

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

  it("refuses an absurdly long file name as an INVALID submission", async () => {
    const name = `${"n".repeat(MAX_FILE_NAME_BYTES)}.pdf`;
    const form = resumeSubmission(
      makeFile(name, "application/pdf", PDF_MAGIC, 2048),
    );

    const response = await postForm(form);

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

  it("refuses more text fields than the payload budget accounts for", async () => {
    const form = completeSubmission("General Question");
    for (let i = 0; i < MAX_TEXT_FIELD_COUNT + 1; i += 1) {
      form.append(`extra-${i}`, "padding");
    }

    const response = await postForm(form);

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

  it("derives the ceiling from the limits it actually enforces", () => {
    expect(MAX_SUBMISSION_BODY_BYTES).toBeGreaterThanOrEqual(
      MAX_RESUME_BYTES + MAX_TEXT_PAYLOAD_BYTES,
    );
    expect(MAX_TEXT_PAYLOAD_BYTES).toBe(
      MAX_TEXT_FIELD_BYTES * MAX_TEXT_FIELD_COUNT,
    );
    // UTF-16 code units on the widget side, bytes here. The heaviest a single
    // code unit can weigh is 3 bytes (a BMP character; a 4-byte character is a
    // surrogate pair and so costs only 2 bytes per unit), so this product is
    // the true upper bound on anything the form will accept.
    expect(MAX_TEXT_FIELD_CHARS * 3).toBeLessThanOrEqual(MAX_TEXT_FIELD_BYTES);
    expect(utf8Bytes(maximalText(MAX_TEXT_FIELD_BYTES))).toBe(
      MAX_TEXT_FIELD_BYTES,
    );
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

  /**
   * W5. The four values were each asserted individually, which says nothing
   * about what else might be on the object: adding `workEmail` to
   * `customMetadata` would have kept every one of those tests green while the
   * raw candidate address was written onto every CV we store.
   *
   * The key set is therefore asserted as a WHOLE. A new key is a deliberate
   * decision about PII, and it should have to be made here.
   */
  it("stores exactly the four agreed metadata keys and nothing else", async () => {
    interceptZapier();
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    expect(Object.keys(metadata).sort()).toEqual([
      "originalFileName",
      "subjectHash",
      "submissionId",
      "submittedAt",
    ]);
  });

  /**
   * The point of the salted HMAC is that erasure works without the address ever
   * being stored. That guarantee is only real if nothing else on the object
   * carries it - in a key, in a value, in any casing.
   */
  it("writes the candidate's work email into no metadata key or value", async () => {
    interceptZapier();
    await postForm(resumeSubmission());

    const { metadata } = await storedObject();
    const flattened = Object.entries(metadata)
      .flat()
      .join("\n")
      .toLowerCase();

    for (const fragment of [
      "jane.doe@example.com",
      "jane.doe",
      "@example.com",
      "workemail",
    ]) {
      expect(flattened).not.toContain(fragment);
    }
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

type MandatoryBinding =
  | "ZAPIER_HOOK_URL"
  | "ZAPIER_SHARED_SECRET"
  | "ERASURE_SALT";

/** `env` with one binding deleted outright, as an unset Worker secret arrives. */
function envWithout(binding: MandatoryBinding): typeof env {
  const clone = { ...env } as Record<string, unknown>;
  delete clone[binding];
  // Through `unknown` deliberately: the whole point is an env that is NOT a
  // complete ProvidedEnv, which is exactly what an unset secret produces.
  return clone as unknown as typeof env;
}

describe("POST /submit - a misconfigured deploy fails loudly, before any side effect", () => {
  /**
   * C2. An unset Worker secret does not throw; it arrives as `undefined`, and
   * `undefined` interpolated into a header is the literal string "undefined".
   * The Zap filter rejects that while the Catch Hook still answers 200, so the
   * Worker reported `{"ok":true}` for every lead it silently destroyed - on a
   * deploy that passed the bodyless probe, because the probe never gets far
   * enough to touch a secret.
   *
   * So the bindings are checked FIRST, ahead of parsing, storage and network.
   * Two consequences are deliberate:
   *
   *   - No R2 object is written. A misconfigured deploy leaves no PII behind,
   *     which is why every row below also asserts the bucket is untouched.
   *   - The bodyless probe now FAILS on a misconfigured deploy instead of
   *     reporting it healthy. That is the point: the gate that was blind to this
   *     failure becomes the gate that catches it.
   */
  const MISCONFIGURATIONS: [string, typeof env, string][] = [
    ["ZAPIER_HOOK_URL omitted", envWithout("ZAPIER_HOOK_URL"), "FORWARD_FAILED"],
    [
      "ZAPIER_HOOK_URL blank",
      { ...env, ZAPIER_HOOK_URL: "" },
      "FORWARD_FAILED",
    ],
    [
      "ZAPIER_HOOK_URL whitespace only",
      { ...env, ZAPIER_HOOK_URL: "   " },
      "FORWARD_FAILED",
    ],
    [
      "ZAPIER_SHARED_SECRET omitted",
      envWithout("ZAPIER_SHARED_SECRET"),
      "FORWARD_FAILED",
    ],
    [
      "ZAPIER_SHARED_SECRET blank",
      { ...env, ZAPIER_SHARED_SECRET: "" },
      "FORWARD_FAILED",
    ],
    ["ERASURE_SALT omitted", envWithout("ERASURE_SALT"), "STORAGE_FAILED"],
    ["ERASURE_SALT blank", { ...env, ERASURE_SALT: "" }, "STORAGE_FAILED"],
  ];

  it.each(MISCONFIGURATIONS)(
    "refuses the submission when %s, storing nothing",
    async (_label, brokenEnv, expectedCode) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/submit`, {
          method: "POST",
          body: resumeSubmission(),
        }),
        brokenEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(502);
      await expect(errorCodeOf(response)).resolves.toBe(expectedCode);

      const listing = await env.RESUMES.list();
      expect(listing.objects).toHaveLength(0);
    },
  );

  /**
   * The missing salt used to escape the error enum entirely: `importKey` with a
   * zero-length secret throws `DataError: Zero-length key is not supported`
   * outside the storage try/catch, so the isolate produced an unhandled
   * exception and a body no probe and no client can interpret.
   */
  it("answers from the fixed enum when ERASURE_SALT is missing, never an unhandled throw", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      envWithout("ERASURE_SALT"),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "STORAGE_FAILED",
    });
  });

  /**
   * The probe contract, restated for a broken deploy. A bodyless POST is what
   * the post-deploy gate sends; on a deploy missing its secrets it must NOT come
   * back as the healthy 400.
   */
  it("fails the bodyless probe signature when a secret is missing", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, { method: "POST" }),
      envWithout("ZAPIER_SHARED_SECRET"),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).not.toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("FORWARD_FAILED");
  });
});

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  const entries = Object.entries(headers ?? {});
  const hit = entries.find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return hit?.[1] ?? "";
}

/** Rebuild the widget form state that produced a fixture, so the sample data
 * lives only in the fixture file. Mirrors the frozen contract test's helper. */
function widgetFieldsFor(
  fixture: ZapierPayload,
  resume: File | null,
): ContactFormFields {
  return {
    inquiryType: fixture.inquiryType as ContactFormFields["inquiryType"],
    firstName: fixture.firstName,
    lastName: fixture.lastName,
    workEmail: fixture.workEmail,
    title: fixture.title,
    company: fixture.company,
    phone: fixture.phone,
    companySize: fixture.companySize,
    estimatedBudget: fixture.estimatedBudget,
    expectedTimeline: fixture.expectedTimeline,
    message: fixture.message,
    resume,
    website: "",
  };
}

function fixtureResumeFile(fixture: ZapierPayload): File | null {
  if (!fixture.resumeFileName) return null;
  return new File(["%PDF-1.4 sample resume"], fixture.resumeFileName, {
    type: "application/pdf",
  });
}

function fixtureFormData(fixture: ZapierPayload): FormData {
  return buildFormData(
    widgetFieldsFor(fixture, fixtureResumeFile(fixture)),
    fixture.source,
  );
}

const FIXTURES: [string, ZapierPayload][] = [
  ["general-question", generalQuestion as ZapierPayload],
  ["consulting", consulting as ZapierPayload],
  ["recruitment-hiring", recruitmentHiring as ZapierPayload],
  ["submit-resume", submitResume as ZapierPayload],
];

describe("POST /submit - forwards flat JSON to Zapier, never multipart", () => {
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  /**
   * THE ANTI-REGRESSION TEST FOR THE BUG THAT COST THIS PROJECT EVERY LEAD.
   *
   * Zapier does not accept multipart/form-data. It DISCARDS the body and still
   * answers HTTP 200, so a multipart forward looks perfectly healthy while every
   * submission is dropped. Nothing about the response can reveal that.
   *
   * So the assertion is on the bytes we sent, compared against the golden
   * fixtures, which are the artifact the backend team maps their Zap from. Only
   * `submittedAt` and `resumeUrl` are substituted, because only those two are
   * legitimately non-deterministic - and both are read from the stored object
   * and from configuration, never copied out of the body under test.
   *
   * A serialization that drops a key, adds a sixteenth, reorders the contract or
   * silently becomes multipart cannot survive this comparison.
   */
  it.each(FIXTURES)(
    "sends %s byte-for-byte as the frozen fixture",
    async (_name, fixture) => {
      const captured = interceptZapier();

      const before = Date.now();
      const response = await postForm(fixtureFormData(fixture));
      const after = Date.now();
      expect(response.status).toBe(200);

      let resumeUrl = "";
      let submittedAt: string;
      if (fixture.resumeFileName) {
        // Independent source: the timestamp written into R2 metadata. Matching
        // it here also proves the stored object and the forwarded lead describe
        // the same instant.
        const { key, metadata } = await storedObject();
        resumeUrl = `${env.RESUME_URL_BASE}/${key}`;
        submittedAt = metadata.submittedAt!;
      } else {
        submittedAt = (JSON.parse(captured.body!) as ZapierPayload).submittedAt;
      }

      // Whichever source it came from, it must be a real instant produced by
      // THIS request. That window is what stops the substitution below from
      // rubber-stamping whatever the Worker happened to send.
      expect(Date.parse(submittedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(submittedAt)).toBeLessThanOrEqual(after);

      const expected = { ...fixture, resumeUrl, submittedAt };
      expect(captured.body).toBe(JSON.stringify(expected));
    },
  );

  it("labels the outbound body as JSON and never as multipart", async () => {
    const captured = interceptZapier();

    await postForm(resumeSubmission());

    const contentType = headerValue(captured.headers, "content-type");
    expect(contentType).toContain("application/json");
    expect(contentType).not.toContain("multipart");
  });

  it("carries no file bytes and no multipart part headers in the body", async () => {
    const captured = interceptZapier();

    await postForm(resumeSubmission());

    expect(captured.body).not.toContain("%PDF");
    expect(captured.body).not.toContain("Content-Disposition");
    expect(captured.body).not.toContain("filename=");
  });

  it("carries all 15 contract keys in the frozen order", async () => {
    const captured = interceptZapier();

    await postForm(fixtureFormData(submitResume as ZapierPayload));

    expect(Object.keys(JSON.parse(captured.body!))).toEqual(
      Object.keys(submitResume),
    );
  });

  /**
   * The Zap filters on this header. Without it, anyone who scraped the hook URL
   * from the old public embed can still post forged leads straight into it.
   * It travels as a HEADER precisely so the 15-key body stays frozen.
   */
  it("authenticates itself with the shared secret in a header", async () => {
    const captured = interceptZapier();

    await postForm(resumeSubmission());

    expect(headerValue(captured.headers, "x-aag-worker-auth")).toBe(
      env.ZAPIER_SHARED_SECRET,
    );
  });

  it("keeps the shared secret out of the body", async () => {
    const captured = interceptZapier();

    await postForm(resumeSubmission());

    expect(captured.body).not.toContain(env.ZAPIER_SHARED_SECRET);
  });
});

describe("POST /submit - 2xx only when storage AND forwarding both succeed", () => {
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("answers 200 with ok:true and the resume URL when both succeed", async () => {
    interceptZapier();

    const response = await postForm(resumeSubmission());
    const body = (await response.json()) as {
      ok?: boolean;
      resumeUrl?: string;
    };
    const { key } = await storedObject();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.resumeUrl).toBe(`${env.RESUME_URL_BASE}/${key}`);
  });

  it("builds the resume URL from configuration, with no hostname in the source", async () => {
    interceptZapier();

    const response = await postForm(resumeSubmission());
    const body = (await response.json()) as { resumeUrl?: string };

    expect(body.resumeUrl?.startsWith(env.RESUME_URL_BASE)).toBe(true);
  });

  /**
   * Spec, and deliberately not "fixed" later: the orphaned object is an ACCEPTED
   * cost. Returning success while the lead is lost is the failure this change
   * exists to eliminate, so the request fails and the file simply stays.
   */
  it("answers 502 FORWARD_FAILED and KEEPS the stored object when Zapier rejects", async () => {
    interceptZapier(500, "upstream exploded");

    const response = await postForm(resumeSubmission());

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("FORWARD_FAILED");
    const listing = await env.RESUMES.list();
    expect(listing.objects).toHaveLength(1);
  });

  /**
   * A 404 from the hook is a DELETED OR MISTYPED hook, which is the single most
   * likely production failure once the old Catch Hook is revoked.
   *
   * This test used to be named "…a non-2xx redirect-ish status" while replying
   * 404. Nothing here is redirect-ish, and that name was the reason the real
   * redirect hole went unnoticed: the suite looked like it covered redirects.
   * The genuine redirect case is its own describe block further down.
   */
  it("answers 502 FORWARD_FAILED when the hook itself is gone (404)", async () => {
    interceptZapier(404, "no such hook");

    const response = await postForm(resumeSubmission());

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("FORWARD_FAILED");
  });

  /**
   * Ordering proof. No interceptor is registered here, so any outbound call
   * would be refused by disableNetConnect and surface as FORWARD_FAILED.
   * Getting STORAGE_FAILED back is what proves Zapier was never contacted.
   */
  it("never contacts Zapier when the R2 put fails", async () => {
    const failingBucket = {
      put: () => Promise.reject(new Error("r2 unavailable")),
    } as unknown as R2Bucket;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      { ...env, RESUMES: failingBucket },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("STORAGE_FAILED");
  });
});

type ConsoleCall = { method: string; args: unknown[] };

/**
 * Flatten a logged value into text a leak scan can actually search.
 *
 * WHY THIS EXISTS, AND WHY `JSON.stringify` IS BANNED HERE.
 *
 * This guard used to capture console output with
 * `args.map((a) => JSON.stringify(a) ?? String(a))`. Both
 * `JSON.stringify(new Error("boom <secret>"))` and
 * `JSON.stringify(new Headers({ "X-AAG-Worker-Auth": "<secret>" }))` evaluate to
 * the string `"{}"` — Error's own properties are non-enumerable and Headers
 * keeps its data in internal slots. So the two log calls this test exists to
 * forbid, `console.error(rawFetchError)` and `console.error(request.headers)`,
 * both serialised to `{}` and sailed through green.
 *
 * A security control whose serializer erases exactly the objects most likely to
 * carry a secret is worse than no control: it certifies the leak. So Errors are
 * unwrapped field by field (name, message, stack, cause), Headers are
 * enumerated, and Request/Response are opened up rather than stringified.
 */
function leakScanText(value: unknown, depth = 0): string {
  if (depth > 6) return "";

  if (value instanceof Error) {
    return [
      value.name,
      value.message,
      value.stack ?? "",
      value.cause === undefined ? "" : leakScanText(value.cause, depth + 1),
    ].join(" ");
  }
  if (value instanceof Headers) {
    return [...value.entries()].map(([k, v]) => `${k}: ${v}`).join(" ");
  }
  if (value instanceof Request || value instanceof Response) {
    const url = value instanceof Request ? value.url : "";
    return `${url} ${leakScanText(value.headers, depth + 1)}`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => leakScanText(entry, depth + 1)).join(" ");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${leakScanText(entry, depth + 1)}`)
      .join(" ");
  }
  return String(value);
}

/** The complete, exclusive key set of the one line this Worker may emit. */
const ALLOWLISTED_LOG_KEYS = [
  "durationMs",
  "errorCode",
  "origin",
  "path",
  "requestId",
  "status",
];

describe("logging never leaks a secret", () => {

  const SECRETS = () => [
    env.ZAPIER_HOOK_URL,
    env.ZAPIER_SHARED_SECRET,
    env.ERASURE_SALT,
  ];

  /** Raw arguments, captured unserialised. Flattening at capture time is what
   * destroyed the evidence before it could ever be asserted on. */
  function captureConsole(): ConsoleCall[] {
    const calls: ConsoleCall[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push({ method, args });
      });
    }
    return calls;
  }

  function scanText(calls: ConsoleCall[]): string {
    return calls
      .map((call) => call.args.map((arg) => leakScanText(arg)).join(" "))
      .join("\n");
  }

  /**
   * The strongest assertion in this file: every console call the Worker makes
   * must be the single allowlisted structured line. A `console.error(err)` fails
   * on the method, on the argument count and on the key set at once.
   */
  function expectOnlyAllowlistedLines(calls: ConsoleCall[]) {
    for (const call of calls) {
      expect(call.method).toBe("log");
      expect(call.args).toHaveLength(1);
      expect(Object.keys(call.args[0] as object).sort()).toEqual(
        ALLOWLISTED_LOG_KEYS,
      );
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.assertNoPendingInterceptors();
  });

  /**
   * The presence half. "No secret appeared in the logs" is trivially true of a
   * Worker that logs nothing at all, so this asserts the allowlisted line IS
   * emitted and carries exactly the permitted keys.
   */
  it("emits one allowlisted log line per request", async () => {
    const calls = captureConsole();
    interceptZapier();

    await postForm(resumeSubmission());

    expect(calls).toHaveLength(1);
    expectOnlyAllowlistedLines(calls);
    const logged = calls[0]!.args[0] as Record<string, unknown>;
    expect(logged.path).toBe("/submit");
    expect(logged.status).toBe(200);
  });

  it("records the received Origin so a misconfigured allowlist is diagnosable", async () => {
    const calls = captureConsole();
    interceptZapier();

    await SELF.fetch(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
      headers: { Origin: "https://wrong-origin.test" },
    });

    const logged = calls[0]!.args[0] as Record<string, unknown>;
    expect(logged.origin).toBe("https://wrong-origin.test");
  });

  /**
   * The absence half, driven across EVERY error path rather than one of them.
   */
  it("leaks no secret while driving every error path", async () => {
    const calls = captureConsole();

    // 400 - unparseable body
    await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" });
    // 413 - measured size
    await postForm(
      resumeSubmission(
        makeFile("cv.pdf", "application/pdf", PDF_MAGIC, MAX_RESUME_BYTES + 1),
      ),
    );
    // 415 - bytes are not a supported container
    await postForm(
      resumeSubmission(makeFile("cv.pdf", "application/pdf", EXE_MAGIC, 512)),
    );
    // 404 - unknown route
    await SELF.fetch(`${ORIGIN}/nope`);
    // 502 - forward rejected
    interceptZapier(500, "upstream exploded");
    await postForm(resumeSubmission());

    expect(calls.length).toBeGreaterThanOrEqual(5);
    expectOnlyAllowlistedLines(calls);
    const output = scanText(calls);
    for (const secret of SECRETS()) {
      expect(secret.length).toBeGreaterThan(0);
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain("upstream exploded");
    expect(output.toLowerCase()).not.toContain("x-aag-worker-auth");
  });

  /**
   * A REJECTED PROMISE CARRYING EVERY SECRET, which is the shape the old guard
   * could not see. The previous version drove a 500 *response* instead - an
   * ordinary status code with nothing sensitive attached - so the branch that
   * catches a thrown error was never exercised with anything worth leaking.
   */
  it("leaks no secret when the R2 put throws an error containing all of them", async () => {
    const calls = captureConsole();
    const poisoned = new Error(
      `r2 exploded ${env.ZAPIER_HOOK_URL} ${env.ZAPIER_SHARED_SECRET} ${env.ERASURE_SALT}`,
    );
    const failingBucket = {
      put: () => Promise.reject(poisoned),
    } as unknown as R2Bucket;

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      { ...env, RESUMES: failingBucket },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expectOnlyAllowlistedLines(calls);
    const output = scanText(calls);
    expect(output).toContain("STORAGE_FAILED");
    for (const secret of SECRETS()) {
      expect(secret.length).toBeGreaterThan(0);
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain("r2 exploded");
  });

  it("leaks no secret when the outbound fetch throws an error containing all of them", async () => {
    const calls = captureConsole();
    const poisoned = new Error(
      `connect ECONNREFUSED ${env.ZAPIER_HOOK_URL} ${env.ZAPIER_SHARED_SECRET} ${env.ERASURE_SALT}`,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(poisoned));

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    fetchSpy.mockRestore();

    await expect(errorCodeOf(response)).resolves.toBe("FORWARD_FAILED");
    expectOnlyAllowlistedLines(calls);
    const output = scanText(calls);
    for (const secret of SECRETS()) {
      expect(secret.length).toBeGreaterThan(0);
      expect(output).not.toContain(secret);
    }
    expect(output).not.toContain("ECONNREFUSED");
  });

  /**
   * Proof that the scanner can see what it claims to see.
   *
   * Without this, every assertion above is unfalsifiable: a serializer that
   * silently collapses Errors and Headers to `{}` produces exactly the same
   * green run as a Worker that leaks nothing. These two cases pin the capability
   * itself, so a future "simplification" back to `JSON.stringify` fails here
   * instead of quietly disarming the whole guard.
   */
  it("can see a secret inside an Error and inside a Headers collection", () => {
    const secret = env.ZAPIER_SHARED_SECRET;

    expect(JSON.stringify(new Error(`boom ${secret}`))).toBe("{}");
    expect(leakScanText(new Error(`boom ${secret}`))).toContain(secret);

    const headers = new Headers({ "X-AAG-Worker-Auth": secret });
    expect(JSON.stringify(headers)).toBe("{}");
    expect(leakScanText(headers)).toContain(secret);
  });
});

const REDIRECT_ORIGIN = "https://redirect-target.test";
const REDIRECT_PATH = "/landed";

describe("POST /submit - a redirected hook is a FAILED forward, never a success", () => {
  /**
   * The founding disaster of this project was "a 2xx that does not mean
   * delivery". `fetch` following redirects recreates it one layer down: if the
   * hook 302s - expired, moved, or replaced by a parking page - the Worker walks
   * to wherever the Location points, that stranger answers 200, and the lead is
   * reported delivered to a Zap that never saw it.
   *
   * THE LOAD-BEARING ASSERTION IS ON THE OUTBOUND REQUEST, not on an observed
   * hop. `fetchMock` does not implement redirect following, so a 302 interceptor
   * comes straight back to the caller and the behavioural test below sees
   * `landed.calls === 0` whether or not the Worker asked to follow it. That
   * control is blind to the very bug it names: it passed green against the
   * implementation that handed the secret to a live redirect target.
   *
   * The redirect POLICY is what this harness can actually observe, and it is the
   * whole fix.
   */
  it("asks fetch NOT to follow redirects when forwarding to the hook", async () => {
    const outbound: RequestInit[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        outbound.push(init ?? {});
        return new Response('{"status":"success"}', { status: 200 });
      });

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    fetchSpy.mockRestore();

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.redirect).toBe("manual");
  });

  /**
   * The destination below is deliberately reachable and deliberately friendly.
   * A test where the redirect target is unreachable proves nothing: the request
   * would fail for lack of a route rather than because we refused to follow it.
   */
  it("answers 502 FORWARD_FAILED when the hook answers 302, and hands the secret to nobody", async () => {
    fetchMock
      .get(ZAPIER_ORIGIN)
      .intercept({ path: ZAPIER_PATH, method: "POST" })
      .reply(302, "", {
        headers: { Location: `${REDIRECT_ORIGIN}${REDIRECT_PATH}` },
      });

    // Any method: 302 rewrites POST to GET, so pinning the method here would
    // let the follow-up miss the interceptor and fail for the wrong reason.
    const landed: { calls: number; auth: string[] } = { calls: 0, auth: [] };
    fetchMock
      .get(REDIRECT_ORIGIN)
      .intercept({ path: REDIRECT_PATH, method: () => true })
      .reply(200, (options) => {
        landed.calls += 1;
        landed.auth.push(
          headerValue(
            options.headers as Record<string, string>,
            "x-aag-worker-auth",
          ),
        );
        return '{"status":"success"}';
      })
      .persist();

    const response = await postForm(resumeSubmission());

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("FORWARD_FAILED");
    expect(landed.calls).toBe(0);
    expect(landed.auth).toEqual([]);
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
