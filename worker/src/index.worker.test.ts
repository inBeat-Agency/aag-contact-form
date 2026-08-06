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
import worker, { type Env } from "./index";
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
    ALLOWED_ORIGINS: string;
    RESUME_HOST: string;
    RESUME_URL_BASE: string;
    RESUME_AUTH_USER: string;
    RESUME_AUTH_PASSWORD: string;
    ZAPIER_HOOK_URL: string;
    ZAPIER_SHARED_SECRET: string;
    ERASURE_SALT: string;
  }
}

const ORIGIN = "https://worker.test";

/**
 * The resume link the contract promises, WRITTEN OUT BY HAND.
 *
 * Every character of this is a literal on purpose. It is not read from
 * `env.RESUME_URL_BASE`, not joined with a separator the Worker also uses, and
 * not produced by any expression the implementation evaluates.
 *
 * The bug this guards against shipped precisely because the assertion was
 * `${env.RESUME_URL_BASE}/${key}` — the production formula, re-typed. A wrong
 * formula then produced an equally wrong expectation and the comparison passed.
 * Deriving an expectation from the thing under test proves the code agrees with
 * itself, which is the one property no test needs to establish.
 *
 * If the miniflare bindings in `vitest.worker.config.ts` change, this constant
 * must be updated BY HAND. That edit is the point: it forces someone to state
 * the new contract deliberately instead of inheriting it silently.
 */
const EXPECTED_RESUME_URL_PREFIX = "https://resume-host.test/resume/";

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
  it('answers 400 with exactly {"ok":false,"error":"INVALID_SUBMISSION"}', async () => {
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

/**
 * THE ORIGINS, TYPED OUT AS LITERALS - DELIBERATELY NOT READ FROM THE BINDING.
 *
 * A prior suite in this repo stayed 66/68 green while the constant it claimed to
 * be testing was changed ten separate times, because every assertion built its
 * expected value out of the very binding it was supposed to be verifying. That
 * test proves the config equals itself and nothing more.
 *
 * So these are written out by hand. `worker/wrangler.config.test.ts` separately
 * asserts the deploy config still declares exactly these two, which is what lets
 * the runtime behaviour proved here and the value actually shipped drift apart
 * loudly instead of silently.
 */
const AAG_PRODUCTION_ORIGIN = "https://www.alphaapexgroup.com";
const AAG_STAGING_ORIGIN = "https://alpha-apex-group.webflow.io";

/**
 * A third listed origin with nothing to do with AAG.
 *
 * It is here so an implementation that hardcodes an AAG hostname - or matches on
 * the substring "alphaapexgroup" - cannot pass this file. The allowlist has to
 * be a list the code READS, never a name the code KNOWS.
 */
const UNRELATED_ALLOWED_ORIGIN = "https://widget.test";

type ProbedSubmit = {
  status: number;
  headerNames: string[];
  header: (name: string) => string | null;
  body: string;
};

async function probeSubmit(init: RequestInit = {}): Promise<ProbedSubmit> {
  const response = await SELF.fetch(`${ORIGIN}/submit`, init);
  const body = await response.text();
  return {
    status: response.status,
    headerNames: [...response.headers.keys()]
      .map((name) => name.toLowerCase())
      .sort(),
    header: (name: string) => response.headers.get(name),
    body,
  };
}

/**
 * THE COMPLETE HEADER SETS, ASSERTED AS SETS.
 *
 * Member-by-member assertions are why a prior metadata guard in this same file
 * stayed green while raw candidate email was being written to every stored
 * object: checking that the things you expect ARE present says nothing whatever
 * about what else is. An `Access-Control-Allow-Origin` that appears when no
 * origin matched is exactly that kind of extra, and only an exact set catches
 * it.
 *
 * `Vary: Origin` is present on every one of them because the response now
 * genuinely differs per caller; without it a shared cache is free to hand one
 * origin's echo to another.
 */
const PREFLIGHT_HEADERS_WITH_ECHO = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-max-age",
  "vary",
];

const PREFLIGHT_HEADERS_WITHOUT_ECHO = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-max-age",
  "vary",
];

const SUBMIT_HEADERS_WITH_ECHO = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-max-age",
  "content-type",
  "vary",
];

const SUBMIT_HEADERS_WITHOUT_ECHO = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-max-age",
  "content-type",
  "vary",
];

describe("CORS: an allowlist that echoes the caller's own origin", () => {
  /**
   * W2, and the reason this change exists.
   *
   * During the AAG migration window the widget is mounted on BOTH the future
   * production origin and the staging one, because production still serves
   * Squarespace. A single allowed origin means every submission from the other
   * one hits the worst failure this project has: multipart is CORS-safelisted,
   * so NO preflight fires, the POST is delivered, the CV is written to R2 and
   * the lead reaches Zapier - and only the RESPONSE is withheld from the page.
   * The candidate sees an error and submits again. Duplicate leads plus a false
   * failure report, and on cutover day it is a certainty rather than a risk.
   */
  const ALLOWED = [
    ["the production origin", AAG_PRODUCTION_ORIGIN],
    ["the staging origin", AAG_STAGING_ORIGIN],
    ["an unrelated listed origin", UNRELATED_ALLOWED_ORIGIN],
  ] as const;

  it.each(ALLOWED)(
    "echoes %s back to itself on POST /submit",
    async (_label, origin) => {
      const probe = await probeSubmit({
        method: "POST",
        headers: { Origin: origin },
      });

      expect(probe.header("Access-Control-Allow-Origin")).toBe(origin);
    },
  );

  it.each(ALLOWED)(
    "echoes %s back to itself on the OPTIONS /submit preflight",
    async (_label, origin) => {
      const probe = await probeSubmit({
        method: "OPTIONS",
        headers: { Origin: origin },
      });

      expect(probe.status).toBe(204);
      expect(probe.header("Access-Control-Allow-Origin")).toBe(origin);
    },
  );

  /**
   * THE WILDCARD AND THE STATIC-VALUE MUTATIONS, CAUGHT IN ONE ASSERTION.
   *
   * `*` cannot be used with credentials and would hand the response to any site
   * on the internet. A static value - including "fall back to the first entry
   * when nothing matched" - silently breaks every other legitimate origin, which
   * is the very outage being fixed here.
   *
   * Collecting all three answers and comparing them as an ORDERED LIST is what
   * makes both mutations red: either one collapses three distinct values into a
   * single repeated one.
   */
  it("gives each listed origin a different answer, never a wildcard and never one fixed value", async () => {
    const echoed: (string | null)[] = [];
    for (const [, origin] of ALLOWED) {
      const probe = await probeSubmit({
        method: "POST",
        headers: { Origin: origin },
      });
      echoed.push(probe.header("Access-Control-Allow-Origin"));
    }

    expect(echoed).toEqual([
      AAG_PRODUCTION_ORIGIN,
      AAG_STAGING_ORIGIN,
      UNRELATED_ALLOWED_ORIGIN,
    ]);
  });

  it("pins the complete header set of an allowed preflight", async () => {
    const probe = await probeSubmit({
      method: "OPTIONS",
      headers: { Origin: AAG_STAGING_ORIGIN },
    });

    expect(probe.status).toBe(204);
    expect(probe.headerNames).toEqual(PREFLIGHT_HEADERS_WITH_ECHO);
  });

  it("pins the complete header set of an allowed POST", async () => {
    const probe = await probeSubmit({
      method: "POST",
      headers: { Origin: AAG_PRODUCTION_ORIGIN },
    });

    expect(probe.headerNames).toEqual(SUBMIT_HEADERS_WITH_ECHO);
  });

  /**
   * The echo must follow the BINDING, not a hostname typed into the source. If
   * it did not, the two tests above would stay green while the next origin
   * change became a code deploy - which is exactly the property this whole
   * design exists to avoid.
   */
  it("echoes whatever the binding lists, not a hostname in source", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "OPTIONS",
        headers: { Origin: "https://late-addition.test" },
      }),
      { ...env, ALLOWED_ORIGINS: "https://late-addition.test" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://late-addition.test",
    );
  });
});

describe("CORS: an origin that is not on the list is never echoed", () => {
  /**
   * SUBSTRING MATCHING IS A VULNERABILITY, AND THIS TABLE IS THE PROOF WE DID
   * NOT WRITE ONE.
   *
   * Each row breaks a different sloppy comparison. The suffix-extended and
   * sibling-subdomain rows kill `startsWith` and `origin.includes(entry)`; the
   * truncated row kills `rawList.includes(origin)` and `entry.includes(origin)`,
   * because "https://www.alphaapexgroup.co" IS a substring of the configured
   * list and someone can register that domain. Only exact equality survives all
   * of them.
   */
  const NEAR_MISSES = [
    ["a scheme downgrade", "http://www.alphaapexgroup.com"],
    ["a trailing slash", "https://www.alphaapexgroup.com/"],
    [
      "a suffix-extended lookalike",
      "https://www.alphaapexgroup.com.attacker.tld",
    ],
    ["a truncated lookalike", "https://www.alphaapexgroup.co"],
    ["a sibling subdomain", "https://evil.alphaapexgroup.com"],
    ["the bare apex without www", "https://alphaapexgroup.com"],
    ["an explicit port", "https://www.alphaapexgroup.com:8443"],
    [
      "a suffix-extended staging lookalike",
      "https://alpha-apex-group.webflow.io.evil.tld",
    ],
    ["a prefixed staging lookalike", "https://not-alpha-apex-group.webflow.io"],
    ["an opaque origin", "null"],
    ["an entirely unrelated site", "https://attacker.example"],
  ] as const;

  it.each(NEAR_MISSES)(
    "refuses to echo %s, emitting no Access-Control-Allow-Origin at all",
    async (_label, origin) => {
      const probe = await probeSubmit({
        method: "POST",
        headers: { Origin: origin },
      });

      expect(probe.headerNames).toEqual(SUBMIT_HEADERS_WITHOUT_ECHO);
    },
  );

  it.each(NEAR_MISSES)(
    "refuses to echo %s on the preflight either",
    async (_label, origin) => {
      const probe = await probeSubmit({
        method: "OPTIONS",
        headers: { Origin: origin },
      });

      expect(probe.status).toBe(204);
      expect(probe.headerNames).toEqual(PREFLIGHT_HEADERS_WITHOUT_ECHO);
    },
  );

  /**
   * REFUSING THE REQUEST WOULD BE WORSE THAN WITHHOLDING THE HEADER.
   *
   * By the time the Worker sees this the multipart body has already crossed the
   * wire - no preflight ever fired - so the candidate has already submitted. A
   * misconfigured allowlist must cost us the acknowledgement, never the lead.
   * This asserts the whole pipeline still ran: 200, our own `ok:true`, and a
   * real resume URL.
   */
  it("still stores and forwards a valid submission that arrived from an unlisted origin", async () => {
    const captured = interceptZapier();

    const response = await postForm(resumeSubmission(), {
      Origin: "https://attacker.example",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(captured.body).toBeTypeOf("string");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("CORS: a request with no Origin header at all", () => {
  /**
   * DOCUMENTED BEHAVIOUR: no `Access-Control-Allow-Origin` is emitted, and the
   * request is processed exactly as it would have been anyway.
   *
   * Same-origin form posts, curl, server-to-server callers and the P1 deploy
   * probe all arrive with no Origin. CORS is a browser mechanism that engages
   * only when the browser sent one, so there is nothing to answer - and
   * answering nothing is the single option that cannot widen access, since
   * there is no origin to widen it to.
   */
  it("emits no Access-Control-Allow-Origin", async () => {
    const probe = await probeSubmit({ method: "POST" });

    expect(probe.headerNames).toEqual(SUBMIT_HEADERS_WITHOUT_ECHO);
  });

  it("emits no Access-Control-Allow-Origin on the preflight", async () => {
    const probe = await probeSubmit({ method: "OPTIONS" });

    expect(probe.status).toBe(204);
    expect(probe.headerNames).toEqual(PREFLIGHT_HEADERS_WITHOUT_ECHO);
  });

  /**
   * The P1 deploy probe sends exactly this request and matches on exactly this
   * body. Withholding a CORS header must not disturb it.
   */
  it("still answers the P1 probe signature", async () => {
    const probe = await probeSubmit({ method: "POST" });

    expect(probe.status).toBe(400);
    expect(probe.body).toBe('{"ok":false,"error":"INVALID_SUBMISSION"}');
  });
});

describe("CORS: the allowlist string is parsed defensively", () => {
  async function preflightWith(allowList: string, requestOrigin: string) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "OPTIONS",
        headers: { Origin: requestOrigin },
      }),
      { ...env, ALLOWED_ORIGINS: allowList },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    return {
      allowOrigin: response.headers.get("Access-Control-Allow-Origin"),
      headerNames: [...response.headers.keys()]
        .map((name) => name.toLowerCase())
        .sort(),
    };
  }

  /**
   * A comma-separated var is edited by hand at deploy time, in a TOML file and
   * in a dashboard field. Padding, a stray trailing comma and a wrapped line are
   * all things a human will produce, and none of them should silently drop an
   * origin - a dropped origin is the outage.
   */
  it.each([
    ["surrounding whitespace", "  https://a.test  ,  https://b.test  "],
    ["empty entries and a trailing comma", "https://a.test,,,https://b.test,"],
    ["newlines and tabs", "\n\thttps://a.test ,\n\thttps://b.test\n"],
  ])("matches both entries when the list carries %s", async (_label, list) => {
    await expect(preflightWith(list, "https://a.test")).resolves.toMatchObject({
      allowOrigin: "https://a.test",
    });
    await expect(preflightWith(list, "https://b.test")).resolves.toMatchObject({
      allowOrigin: "https://b.test",
    });
  });

  it("matches a single-entry list that has no comma at all", async () => {
    await expect(
      preflightWith("https://only.test", "https://only.test"),
    ).resolves.toMatchObject({ allowOrigin: "https://only.test" });
  });

  /**
   * Fail closed on the HEADER, never on the request. An unusable allowlist is an
   * unconfigured deploy and must not hand the response to anybody, but the
   * submission itself still has to go through: see the unlisted-origin test
   * above for why losing the lead is the worse outcome.
   */
  it.each([
    ["unset", ""],
    ["whitespace only", "   \n\t  "],
    ["commas only", ",,,"],
  ])("echoes nothing when the allowlist is %s", async (_label, list) => {
    await expect(
      preflightWith(list, AAG_PRODUCTION_ORIGIN),
    ).resolves.toMatchObject({ headerNames: PREFLIGHT_HEADERS_WITHOUT_ECHO });
  });
});

describe("CORS is scoped to /submit only", () => {
  /**
   * W6. `/resume` streams candidate CVs on the origin whose session IS the
   * Access identity. Making that stream cross-origin readable would hand any
   * page the ability to read PII with the staff member's own session.
   *
   * The listed origin is used on purpose: a `/resume` handler that reused the
   * `/submit` CORS helper would echo it, and this has to be the test that
   * notices.
   */
  it("emits no Access-Control-Allow-Origin on a non-/submit path, even from a listed origin", async () => {
    const response = await SELF.fetch(
      `${ORIGIN}/resume/11111111-2222-4333-8444-555555555555`,
      { headers: { Origin: AAG_PRODUCTION_ORIGIN } },
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

  it.each([
    "not-an-email",
    "jane.doe@",
    "@example.com",
    "jane doe@x.com",
    "jane@example",
  ])("refuses the unusable work email %p", async (email) => {
    const form = completeSubmission("General Question");
    form.set("workEmail", email);

    const response = await postForm(form);

    expect(response.status).toBe(400);
    await expect(errorCodeOf(response)).resolves.toBe("INVALID_SUBMISSION");
  });

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
      await new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: form,
      }).arrayBuffer()
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
  for (const field of [
    "firstName",
    "lastName",
    "title",
    "company",
    "phone",
    "message",
  ]) {
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
    const flattened = Object.entries(metadata).flat().join("\n").toLowerCase();

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

  /**
   * RESUME_URL_BASE says where the link points. RESUME_HOST says where `/resume`
   * is answered. Two bindings, one fact — so they can contradict each other, and
   * when they do EVERY emitted link is dead on arrival with nothing in the
   * response to say so. That is the same silent-dead-link failure as the missing
   * path segment, arriving through configuration instead of code.
   *
   * The suite itself shipped this contradiction for months: RESUME_HOST was
   * `resume-host.test` while RESUME_URL_BASE was `https://resume.test/resume`,
   * and 335 tests asserted links pointing at a host the router would refuse.
   */
  it("refuses to build a resume URL for a host that does not serve resumes", async () => {
    const request = new Request(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      {
        ...env,
        RESUME_URL_BASE: "https://links-here.example.test",
        RESUME_HOST: "but-served-here.example.test",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("STORAGE_FAILED");
  });

  /**
   * The base is an ORIGIN and nothing else.
   *
   * Allowing it to carry a path is exactly how `/resume` went missing: the
   * segment lived in configuration on the test deploy and in code on the real
   * one, so neither side could tell which owned it and both assumed the other
   * did. Rejecting a path here means {@link RESUME_PATH_PREFIX} is the only
   * place it can come from.
   */
  it("refuses a RESUME_URL_BASE that carries its own path", async () => {
    const request = new Request(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      { ...env, RESUME_URL_BASE: "https://resume-host.test/resume" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    await expect(errorCodeOf(response)).resolves.toBe("STORAGE_FAILED");
  });
});

type MandatoryBinding =
  "ZAPIER_HOOK_URL" | "ZAPIER_SHARED_SECRET" | "ERASURE_SALT";

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
    [
      "ZAPIER_HOOK_URL omitted",
      envWithout("ZAPIER_HOOK_URL"),
      "FORWARD_FAILED",
    ],
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
  const hit = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
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
   * legitimately non-deterministic.
   *
   * BE PRECISE ABOUT WHERE EACH SUBSTITUTION COMES FROM - this comment used to
   * claim neither was "copied out of the body under test", and that was not
   * true:
   *
   *   - `resumeUrl` is a hand-written literal plus the key read back from R2.
   *     Nothing the Worker computes contributes to it. It used to be rebuilt
   *     with the production formula, which is how a link missing its `/resume`
   *     segment passed this comparison all the way into a live deploy.
   *   - `submittedAt` comes from R2 metadata when a resume was stored. For the
   *     other three fixtures no object exists, so it IS read out of the captured
   *     body - there is no second source to read it from. What stops that from
   *     rubber-stamping itself is the window assertion below: the value must
   *     parse to an instant inside the request it was produced by, so a frozen,
   *     stale or fabricated timestamp still fails.
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
        // Literal prefix + the opaque key read back from R2. The key is the
        // only value taken from the system, and R2 is an independent source
        // rather than the expression that built the URL.
        resumeUrl = EXPECTED_RESUME_URL_PREFIX + key;
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
    expect(body.resumeUrl).toBe(EXPECTED_RESUME_URL_PREFIX + key);
  });

  /**
   * Proves the hostname comes from configuration by BINDING A DIFFERENT ONE and
   * requiring the emitted link to follow it.
   *
   * The previous version asserted `resumeUrl.startsWith(env.RESUME_URL_BASE)`,
   * which a source-hardcoded hostname would also satisfy on any deploy where
   * the two happened to match — and it read the expectation straight out of the
   * binding under test. Relocating the host and asserting a literal is what
   * actually distinguishes "read from config" from "baked into the source".
   */
  it("builds the resume URL from configuration, with no hostname in the source", async () => {
    interceptZapier();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      {
        ...env,
        RESUME_URL_BASE: "https://relocated.example.test",
        RESUME_HOST: "relocated.example.test",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);

    const { key } = await storedObject();
    const body = (await response.json()) as { resumeUrl?: string };

    expect(body.resumeUrl).toBe("https://relocated.example.test/resume/" + key);
  });

  /**
   * THE LINK MUST LAND ON THE ROUTE THE WORKER ACTUALLY SERVES.
   *
   * The first remote deploy emitted `https://<base>/<key>` while the router only
   * answers under `/resume/`, so every lead arrived carrying a 404. Storage was
   * fine, the forward was fine, and 335 local tests were green — because the
   * test rebuilt its expectation with the SAME expression as the implementation
   * (`${env.RESUME_URL_BASE}/${key}`) and a wrong formula therefore produced a
   * matching wrong expectation.
   *
   * So this expectation is a LITERAL, spelled out in full, taken from the
   * published contract rather than computed by anything the Worker also runs.
   * The only value read back from the system is the opaque key, and that comes
   * from R2 — an independent source, not the expression under test. Change the
   * path segment in the implementation and this test goes red; that is the
   * entire point of writing it out by hand.
   */
  it("emits the resume URL under the literal /resume/ path", async () => {
    const captured = interceptZapier();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      {
        ...env,
        RESUME_URL_BASE: "https://resume.example.test",
        RESUME_HOST: "resume.example.test",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);

    const { key } = await storedObject();
    const expected = "https://resume.example.test/resume/" + key;

    const body = (await response.json()) as { resumeUrl?: string };
    expect(body.resumeUrl).toBe(expected);
    expect((JSON.parse(captured.body!) as ZapierPayload).resumeUrl).toBe(
      expected,
    );
  });

  /**
   * The end-to-end oracle no formula can fake: take the link the Worker just
   * emitted, ask the Worker for it, and require the candidate's bytes back.
   *
   * This asserts nothing about how the URL is built, so it cannot be satisfied
   * by agreeing with a broken construction. It fails if the path segment is
   * wrong, and it fails if the emitted host is not the host the `/resume`
   * host-lock admits — the second defect the literal test above cannot see.
   */
  it("emits a link that resolves to the stored bytes when fetched", async () => {
    interceptZapier();

    const response = await postForm(resumeSubmission());
    const { resumeUrl: emitted } = (await response.json()) as {
      resumeUrl?: string;
    };

    const download = await probeResume(emitted!, authed());

    expect(download.status).toBe(200);
    expect(download.bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);

    // The same link, end to end, is USELESS to whoever intercepts it. The URL
    // travels through Zapier, an inbox and a chat client before a staff member
    // clicks it, so "the link resolves" and "the link is gated" are one journey
    // and are asserted together rather than in two places that could drift.
    const intercepted = await probeResume(emitted!);
    expect(intercepted.status).toBe(401);
    expect(intercepted.bytes.slice(0, PDF_MAGIC.length)).not.toEqual(PDF_MAGIC);
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

/** The sorted key set of each console call, in the order they were emitted. */
function loggedKeySets(calls: ConsoleCall[]): string[][] {
  return calls.map((call) => Object.keys(call.args[0] as object).sort());
}

/** The complete, exclusive key set of the request line this Worker may emit. */
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
    env.RESUME_AUTH_USER,
    env.RESUME_AUTH_PASSWORD,
  ];

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

  /**
   * THE RESUME CREDENTIAL, WHICH NOW TRAVELS ON EVERY GATED REQUEST.
   *
   * The three secrets above are read from bindings and only ever reach an
   * outbound call. This one arrives in an INBOUND header on every single staff
   * download, which makes `console.log(request.headers)` — or any well-meaning
   * "log the request for debugging" — a direct credential leak.
   *
   * Scanning for the raw username and password is NOT sufficient and that is the
   * whole reason this test is separate. The credential travels base64-encoded,
   * so an implementation that echoed the `Authorization` header verbatim would
   * emit `Basic dGVzdC1yZXN1bWUt…` — a string containing neither plaintext
   * value. The encoded blob and the header name are therefore scanned for in
   * their own right. This is the same shape as the #2454 finding, where the
   * serializer, not the assertion, was what made the guard blind.
   *
   * Every /resume auth outcome is driven: accepted, rejected, and unconfigured.
   */
  describe("the /resume credential, which arrives inbound on every gated request", () => {
    // Seeded in beforeAll, never inside the test: an R2 write performed in the
    // body of an `it` cannot be popped off the isolated-storage stack and takes
    // the whole file down with an error that hides every real assertion.
    beforeAll(async () => {
      await seedResume(STORED_RESUME_KEY);
    });

    it("leaks no resume credential while driving every /resume auth path", async () => {
      const calls = captureConsole();

      // Accepted — the only path that also writes an audit line.
      await probeResume(
        resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
        authed(),
      );
      // Rejected, credential present and wrong.
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), {
        headers: { Authorization: RESUME_BASIC_WRONG_PASSWORD },
      });
      // Rejected, no credential at all.
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY));
      // Wrong host, valid credential — must not echo it while refusing.
      await probeResume(resumeUrl("worker.test", STORED_RESUME_KEY), authed());
      // Unconfigured deploy, valid credential supplied. The body is drained
      // unconditionally: an ungated response here carries a live R2 stream, and
      // leaving one open aborts the whole file with an isolated-storage error
      // that buries every assertion below.
      const ctx = createExecutionContext();
      const unconfigured = await worker.fetch(
        new Request(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), authed()),
        { ...env, RESUME_AUTH_PASSWORD: "" },
        ctx,
      );
      await unconfigured.arrayBuffer();
      await waitOnExecutionContext(ctx);

      // Presence first: the runs above really did produce log output to scan.
      expect(calls.length).toBeGreaterThanOrEqual(6);

      const output = scanText(calls);
      for (const secret of SECRETS()) {
        expect(secret.length).toBeGreaterThan(0);
        expect(output).not.toContain(secret);
      }
      // The transport forms, which contain neither plaintext value.
      expect(output).not.toContain(
        "dGVzdC1yZXN1bWUtdXNlcjp0ZXN0LXJlc3VtZS1wYXNzd29yZC03YzFlNWE=",
      );
      expect(output).not.toContain(RESUME_BASIC_WRONG_PASSWORD);
      expect(output.toLowerCase()).not.toContain("authorization");
      expect(output.toLowerCase()).not.toContain("basic ");
    });
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

/**
 * A key that exists in the simulated bucket for the whole retrieval block.
 *
 * Every wrong-host and misconfiguration test below asks for THIS key, the one
 * proven retrievable on the configured host. A 404 is therefore attributable to
 * the host lock and to nothing else - asking for a key that does not exist would
 * produce the same 404 with the lock deleted.
 */
const STORED_RESUME_KEY = "9c1f0f7a-6c1e-4a2b-9d33-2f5b7c8e1a04";

/** Real leading bytes plus a marker no other fixture in this file contains. */
const STORED_RESUME_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0xde, 0xad, 0xbe, 0xef, 0x0a,
]);

const STORED_RESUME_TYPE = "application/pdf";
const STORED_RESUME_FILE_NAME = "Jane-Doe-CV.pdf";

async function seedResume(
  key: string,
  fileName: string = STORED_RESUME_FILE_NAME,
  contentType: string = STORED_RESUME_TYPE,
): Promise<void> {
  await env.RESUMES.put(key, STORED_RESUME_BYTES, {
    httpMetadata: { contentType },
    customMetadata: {
      originalFileName: fileName,
      submittedAt: "2026-08-05T00:00:00.000Z",
      submissionId: key,
      subjectHash: "0".repeat(64),
    },
  });
}

function resumeUrl(host: string, key: string): string {
  return `https://${host}/resume/${key}`;
}

async function bodyBytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

type ProbedResume = {
  status: number;
  headerNames: string[];
  header: (name: string) => string | null;
  bytes: number[];
};

/**
 * Fetch a resume and DRAIN THE BODY BEFORE ANY ASSERTION RUNS.
 *
 * A 200 from `/resume` carries a live R2 stream. Leaving it unread when an
 * expectation fails makes Miniflare abort the whole file with "Failed to pop
 * isolated storage stack frame" - which buries the assertion diff that was
 * about to tell you what actually broke. Draining up front means a red test
 * reports itself instead of taking the run down with it.
 */
async function probeResume(
  url: string,
  init?: RequestInit,
): Promise<ProbedResume> {
  const response = await SELF.fetch(url, init);
  const bytes = [...new Uint8Array(await response.arrayBuffer())];
  return {
    status: response.status,
    headerNames: [...response.headers.keys()]
      .map((name) => name.toLowerCase())
      .sort(),
    header: (name: string) => response.headers.get(name),
    bytes,
  };
}

/**
 * A valid `Authorization` header for the bound test credential, BASE64 WRITTEN
 * OUT BY HAND.
 *
 * It is deliberately NOT built as `btoa(\`${env.RESUME_AUTH_USER}:${env.RESUME_AUTH_PASSWORD}\`)`.
 * That expression is the production decode re-typed backwards: an implementation
 * that split on the wrong character, or decoded latin1 instead of UTF-8, would
 * be handed an input shaped by its own bug and would pass. The same defect class
 * already shipped twice in this repo — once as a formula (`${RESUME_URL_BASE}/${key}`)
 * and once as a fixture that smuggled `/resume` into a binding.
 *
 * The link between this literal and the bindings is asserted ONCE, explicitly,
 * in "pins the test bindings this credential encodes". Editing either side
 * without the other turns the suite red, which is the entire point.
 */
const RESUME_BASIC_HEADER =
  "Basic dGVzdC1yZXN1bWUtdXNlcjp0ZXN0LXJlc3VtZS1wYXNzd29yZC03YzFlNWE=";

/** Same shape, wrong password in the final character. */
const RESUME_BASIC_WRONG_PASSWORD =
  "Basic dGVzdC1yZXN1bWUtdXNlcjp0ZXN0LXJlc3VtZS1wYXNzd29yZC03YzFlNWI=";

/** Same shape, wrong username in the final character. */
const RESUME_BASIC_WRONG_USER =
  "Basic dGVzdC1yZXN1bWUtdXNlczp0ZXN0LXJlc3VtZS1wYXNzd29yZC03YzFlNWE=";

/**
 * The same narrowing the Worker uses for the Cloudflare-only
 * `crypto.subtle.timingSafeEqual`, which the DOM lib does not declare.
 *
 * This is the SAME OBJECT as `crypto.subtle` — a cast changes the type, not the
 * reference — so a spy installed here is the spy the Worker's call hits.
 */
const timingSafeSubtle = crypto.subtle as unknown as {
  timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
};

/** Attach the valid credential without disturbing anything else in the init. */
function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: RESUME_BASIC_HEADER,
    },
  };
}

/**
 * An R2 binding that RECORDS every key it is asked for and refuses to serve one.
 *
 * The fail-closed tests must prove the Worker never reaches storage, and "no
 * bytes came back" cannot prove that — a 401 emitted after a successful read
 * looks identical from outside. This records the reads instead, and a companion
 * test drives a real download through the same spy so the recorder is shown to
 * work rather than assumed to.
 */
function recordingBucket(): { bucket: R2Bucket; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    bucket: {
      get: (key: string) => {
        reads.push(key);
        return Promise.resolve(null);
      },
    } as unknown as R2Bucket,
  };
}

describe("GET /resume — route reachability and response contract", () => {
  // Authorization is now enforced IN THIS WORKER (see the Basic Auth block
  // below), so a green run here does prove the gate exists — unlike the
  // Cloudflare Access model these tests were originally written against, which
  // Miniflare structurally could not observe.

  beforeAll(async () => {
    await seedResume(STORED_RESUME_KEY);
  });

  it("streams the stored bytes on the configured resume host", async () => {
    const response = await SELF.fetch(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed(),
    );

    expect(response.status).toBe(200);
    await expect(bodyBytesOf(response)).resolves.toEqual([
      ...STORED_RESUME_BYTES,
    ]);
  });

  /**
   * THE LOAD-BEARING TEST OF THIS SLICE.
   *
   * Cloudflare Access is bound to ONE hostname. The submit host resolves to the
   * same Worker, so without this comparison `<submit-host>/resume/<key>` serves
   * candidate CVs with no gate in front of them at all - the Access app is on
   * the other name and never sees the request.
   *
   * The key asked for here is the one the test above just proved retrievable, so
   * the 404 can only come from the host check.
   */
  it("answers 404 NOT_FOUND for a retrievable key on a host that is not the configured one", async () => {
    const response = await SELF.fetch(
      resumeUrl("worker.test", STORED_RESUME_KEY),
      authed(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  /**
   * The lock must follow the BINDING, not a literal typed into the source. A
   * hardcoded hostname would keep the two tests above green while making the
   * pending domain migration a code change - which the spec forbids.
   */
  it("locks onto whatever RESUME_HOST is bound to, not a hostname in source", async () => {
    const ctx = createExecutionContext();
    const served = await worker.fetch(
      new Request(
        resumeUrl("alternate-resume.test", STORED_RESUME_KEY),
        authed(),
      ),
      { ...env, RESUME_HOST: "alternate-resume.test" },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(served.status).toBe(200);
    await expect(bodyBytesOf(served)).resolves.toEqual([
      ...STORED_RESUME_BYTES,
    ]);

    const refused = await SELF.fetch(
      resumeUrl("alternate-resume.test", STORED_RESUME_KEY),
      authed(),
    );
    expect(refused.status).toBe(404);
  });

  /**
   * Fail closed. An unset RESUME_HOST is an unconfigured deploy, and an
   * unconfigured deploy must not serve PII from every hostname that reaches this
   * Worker - including `*.workers.dev` and preview URLs, which no Access app
   * covers.
   */
  it("serves nothing anywhere when RESUME_HOST is unset", async () => {
    for (const host of ["worker.test", "resume-host.test", "anything.test"]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(resumeUrl(host, STORED_RESUME_KEY), authed()),
        { ...env, RESUME_HOST: "" },
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "NOT_FOUND",
      });
    }
  });

  it("answers 404 NOT_FOUND for an unknown key on the configured host", async () => {
    const response = await SELF.fetch(
      resumeUrl(env.RESUME_HOST, "00000000-0000-4000-8000-000000000000"),
      authed(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  it("answers 404 NOT_FOUND when no key follows /resume/", async () => {
    for (const path of ["/resume", "/resume/"]) {
      const response = await SELF.fetch(
        `https://${env.RESUME_HOST}${path}`,
        authed(),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "NOT_FOUND",
      });
    }
  });

  it("answers 404 NOT_FOUND to a non-GET method on the configured host", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await SELF.fetch(
        resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
        { method },
      );

      expect(response.status).toBe(404);
    }
  });

  /**
   * THE ASYMMETRY IS DELIBERATE, so it gets its own assertion.
   *
   * `/submit` is NOT host-locked. Locking it buys no security - the endpoint is
   * public by design - and every hostname that stops accepting submissions is
   * 100% lead loss, the exact failure this whole change exists to eliminate.
   */
  /**
   * THE COMPLETE HEADER SET, ASSERTED AS A SET.
   *
   * Member-by-member assertions are why a prior metadata guard stayed 112/115
   * green while raw candidate email was being written to every object: checking
   * that the things you expect are present says nothing about what ELSE is. Here
   * an accidental `Access-Control-Allow-Origin` - the W6 failure that would make
   * a candidate's CV readable cross-origin using a staff member's own Access
   * session - has to turn this red, and only an exact set does that.
   *
   * These are exactly the five D-L hardening headers plus the stored content
   * type, and nothing else. The Worker streams the object without declaring a
   * length, so no transport header joins them.
   */
  const RESUME_200_HEADERS = [
    "cache-control",
    "content-disposition",
    "content-security-policy",
    "content-type",
    "referrer-policy",
    "x-content-type-options",
  ];

  const RESUME_404_HEADERS = ["content-type"];

  it("pins the complete header set of a successful download", async () => {
    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed(),
    );

    expect(download.status).toBe(200);
    expect(download.headerNames).toEqual(RESUME_200_HEADERS);
  });

  /**
   * D-L. A CV is an attacker-supplied binary served on the origin whose sessions
   * ARE the Access identity. A malicious PDF that renders inline runs in that
   * origin. Every one of these is what keeps it a download instead of a page.
   */
  it("hardens every successful download against being rendered inline", async () => {
    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed(),
    );

    expect(download.header("X-Content-Type-Options")).toBe("nosniff");
    expect(download.header("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(download.header("Referrer-Policy")).toBe("no-referrer");
    expect(download.header("Cache-Control")).toBe("private, no-store");
  });

  it("serves the download with the content type it was stored under", async () => {
    const docxKey = "3a7d2e10-88b4-4c6f-b1a2-77c9e0d4f5b6";
    const docxType =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await seedResume(docxKey, "Jane-Doe-CV.docx", docxType);

    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, docxKey),
      authed(),
    );

    expect(download.header("Content-Type")).toBe(docxType);
  });

  it("offers the stored original filename as an attachment", async () => {
    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed(),
    );

    expect(download.header("Content-Disposition")).toBe(
      `attachment; filename="${STORED_RESUME_FILE_NAME}"`,
    );
  });

  /**
   * HEADER INJECTION. The filename is candidate-supplied and travels into a
   * response header verbatim. A CR/LF in it splits the header block and lets the
   * uploader dictate headers - or a whole second response - to the staff browser
   * that downloads the file. A bare quote closes the quoted-string early and
   * does the same with parameters.
   */
  it("strips CR, LF, quotes and backslashes out of the stored filename", async () => {
    const hostileKey = "c4e8b6a2-5d31-4f88-9a70-1b2c3d4e5f60";
    await seedResume(
      hostileKey,
      'ev"il\r\nX-Injected: yes\r\n\r\n<script>alert(1)</script>\\cv.pdf',
    );

    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, hostileKey),
      authed(),
    );

    expect(download.header("Content-Disposition")).toBe(
      'attachment; filename="evilX-Injected: yes<script>alert(1)</script>cv.pdf"',
    );
    expect(download.header("X-Injected")).toBeNull();
    expect(download.headerNames).toEqual(RESUME_200_HEADERS);
  });

  it("still names the attachment when the stored filename is missing or sanitises away", async () => {
    const namelessKey = "d5f9c7b3-6e42-4099-8b81-2c3d4e5f6071";
    await env.RESUMES.put(namelessKey, STORED_RESUME_BYTES, {
      httpMetadata: { contentType: STORED_RESUME_TYPE },
      customMetadata: { submittedAt: "2026-08-05T00:00:00.000Z" },
    });

    const strippedKey = "e6a0d8c4-7f53-4100-9c92-3d4e5f607182";
    await seedResume(strippedKey, '"""');

    for (const key of [namelessKey, strippedKey]) {
      const download = await probeResume(
        resumeUrl(env.RESUME_HOST, key),
        authed(),
      );

      expect(download.status).toBe(200);
      expect(download.header("Content-Disposition")).toBe(
        'attachment; filename="resume"',
      );
    }
  });

  /**
   * W6, stated as its own test because it is a rule about the whole route rather
   * than about one response. CORS belongs to `/submit` and nowhere else.
   */
  it("emits no Access-Control-Allow-Origin on any /resume response", async () => {
    const probes = [
      await probeResume(
        resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
        authed(),
      ),
      await probeResume(resumeUrl("worker.test", STORED_RESUME_KEY), authed()),
      await probeResume(
        resumeUrl(env.RESUME_HOST, "00000000-0000-4000-8000-000000000000"),
        authed(),
      ),
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), {
        method: "POST",
      }),
      // The auth challenge is a /resume response too, and it is the one an
      // unauthenticated cross-origin page can actually provoke.
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY)),
    ];

    for (const probe of probes) {
      expect(probe.header("Access-Control-Allow-Origin")).toBeNull();
    }

    // Proves the loop above actually covered a success AND the failure paths,
    // rather than five responses that were all refused before any header ran.
    expect(probes.map((probe) => probe.status)).toEqual([
      200, 404, 404, 404, 401,
    ]);
  });

  it("pins the complete header set of every /resume 404", async () => {
    const refusals = [
      await probeResume(resumeUrl("worker.test", STORED_RESUME_KEY), authed()),
      await probeResume(
        resumeUrl(env.RESUME_HOST, "00000000-0000-4000-8000-000000000000"),
        authed(),
      ),
      await probeResume(`https://${env.RESUME_HOST}/resume/`, authed()),
    ];

    for (const refusal of refusals) {
      expect(refusal.status).toBe(404);
      expect(refusal.headerNames).toEqual(RESUME_404_HEADERS);
    }
  });

  /**
   * PER-DOWNLOAD AUDIT.
   *
   * This line is the ONLY record of who read which CV. Access authenticates the
   * reader at the edge and then forgets; without this, PII access on this route
   * is completely unattributable after the fact.
   *
   * It is deliberately two keys wide. The candidate's own details are NOT in it:
   * the subject is already identified by the key, and copying their email into
   * the log would spread the PII this route exists to protect.
   */
  /**
   * TWO KEYS, AND `email` IS DELIBERATELY GONE.
   *
   * Under Cloudflare Access this line carried `Cf-Access-Authenticated-User-Email`,
   * because Access authenticated a PERSON and then forgot them. Basic Auth
   * authenticates a SHARED credential: there is no person to name. Keeping an
   * `email` key would have meant writing `<no-access-identity>` on every single
   * download — a field that looks like an alarm and is in fact the normal case,
   * which is how a real alarm gets trained out of a team.
   *
   * `auth` records the fact that the read was authenticated and the mechanism
   * that authenticated it, and claims nothing further. Per-person attribution is
   * a known, accepted loss of this decision, not an oversight.
   */
  const AUDIT_LOG_KEYS = ["auth", "key"];

  /** Left over from the superseded Access model; must never be echoed anywhere. */
  const ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";

  afterEach(() => vi.restoreAllMocks());

  it("audits a successful download with the key and the authentication method", async () => {
    const calls = captureConsole();

    await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), authed());

    // Exactly two lines, in this order: the audit is written at the moment the
    // object is read, not assembled at the end where a later throw could skip
    // it, and the request line keeps its own untouched shape.
    expect(loggedKeySets(calls)).toEqual([
      AUDIT_LOG_KEYS,
      ALLOWLISTED_LOG_KEYS,
    ]);
    expect(calls[0]!.args[0]).toEqual({
      key: STORED_RESUME_KEY,
      auth: "basic",
    });
  });

  /**
   * AN UNAUTHENTICATED 200 IS STRUCTURALLY IMPOSSIBLE, and this is the runtime
   * half of that claim.
   *
   * The compile-time half is that `handleResumeDownload` cannot be called
   * without a `ResumeAuthGrant`, and the only expression in the file that
   * produces one sits behind the constant-time comparison. So `auth: "basic"`
   * is not a label the audit chooses — it is read off the proof that let the
   * download happen at all. A download with no grant does not log differently;
   * it does not compile.
   */
  it("never emits an audit line for a request that was not authenticated", async () => {
    const calls = captureConsole();

    const challenged = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
    );

    expect(challenged.status).toBe(401);
    expect(loggedKeySets(calls)).toEqual([ALLOWLISTED_LOG_KEYS]);
  });

  /**
   * Nothing was read, so there is nothing to attribute. An audit line on a
   * refusal would also turn the log into a key-probing oracle.
   */
  it("writes no audit line for any /resume refusal", async () => {
    const calls = captureConsole();

    const refusals = [
      await probeResume(resumeUrl("worker.test", STORED_RESUME_KEY), authed()),
      await probeResume(
        resumeUrl(env.RESUME_HOST, "00000000-0000-4000-8000-000000000000"),
        authed(),
      ),
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), {
        method: "POST",
      }),
      await probeResume(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY)),
    ];

    expect(refusals.map((refusal) => refusal.status)).toEqual([
      404, 404, 404, 401,
    ]);
    expect(loggedKeySets(calls)).toEqual([
      ALLOWLISTED_LOG_KEYS,
      ALLOWLISTED_LOG_KEYS,
      ALLOWLISTED_LOG_KEYS,
      ALLOWLISTED_LOG_KEYS,
    ]);
  });

  /**
   * A leftover Access identity header on the request must not be copied into
   * either log line. The Access model is superseded; echoing the header would
   * put a staff member's address into the allowlisted request line on every
   * request the Worker serves, including the public ones.
   */
  it("never echoes a supplied Access identity into any log line", async () => {
    const calls = captureConsole();

    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed({
        headers: { [ACCESS_EMAIL_HEADER]: "staff.member@example.test" },
      }),
    );

    expect(download.status).toBe(200);
    expect(loggedKeySets(calls)).toEqual([
      AUDIT_LOG_KEYS,
      ALLOWLISTED_LOG_KEYS,
    ]);

    const requestLine = calls[1]!.args[0] as Record<string, unknown>;
    expect(requestLine.path).toBe(`/resume/${STORED_RESUME_KEY}`);
    expect(requestLine.status).toBe(200);
    expect(
      calls.map((call) => leakScanText(call.args[0])).join("\n"),
    ).not.toContain("staff.member@example.test");
  });

  it("keeps /submit answering on a host that is not the resume host", async () => {
    interceptZapier();

    const response = await SELF.fetch("https://some-other-host.test/submit", {
      method: "POST",
      body: resumeSubmission(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumeUrl: expect.stringMatching(
        /^https:\/\/resume-host\.test\/resume\/[0-9a-f-]{36}$/,
      ),
    });
  });
});

/**
 * The challenge value a browser needs in order to show its native prompt.
 * Written out whole: `realm` and `charset` are a published contract, and a
 * member-by-member check would stay green if one of them vanished.
 */
const RESUME_CHALLENGE = 'Basic realm="AAG Resume Downloads", charset="UTF-8"';

/** The complete, exclusive header set of a /resume auth challenge. */
const RESUME_401_HEADERS = ["content-type", "www-authenticate"];

describe("GET /resume — HTTP Basic Auth gate", () => {
  beforeAll(async () => {
    await seedResume(STORED_RESUME_KEY);
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * THE BINDING AUDIT.
   *
   * Every other test in this block leans on `RESUME_BASIC_HEADER`, a base64
   * literal. That literal is only meaningful if the bindings still hold the
   * values it encodes — and a fixture quietly supplying part of the value under
   * test is exactly how the missing `/resume` segment survived two adversarial
   * gates. So the bindings are pinned here as literals rather than trusted.
   *
   * Change `vitest.worker.config.ts` and this test goes red first, naming the
   * problem, instead of every auth test going red for reasons nobody can read.
   */
  it("pins the test bindings this credential encodes", () => {
    expect(env.RESUME_AUTH_USER).toBe("test-resume-user");
    expect(env.RESUME_AUTH_PASSWORD).toBe("test-resume-password-7c1e5a");
  });

  /**
   * THE PRESENCE OF A SUCCESS SIGNAL.
   *
   * Every finding in #2378 came from the same root cause: controls that assert
   * the absence of a failure. "It did not 200" is satisfied by a Worker that is
   * simply broken. This asserts the gate OPENS for the right credential and
   * hands back the exact stored bytes, so the refusal tests below mean refusal
   * rather than breakage.
   */
  it("streams the exact stored bytes when the configured credential is supplied", async () => {
    const download = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      authed(),
    );

    expect(download.status).toBe(200);
    expect(download.bytes).toEqual([...STORED_RESUME_BYTES]);
  });

  /**
   * FAIL CLOSED — THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE.
   *
   * Under Cloudflare Access, an unconfigured deploy meant a dead route, and a
   * dead route was safe. Moving the gate into code INVERTS that: the Worker now
   * decides for itself whether to serve, so an unset credential must mean
   * "refuse everyone", never "let everyone through". Getting this backwards
   * publishes every CV in the bucket to anyone who can guess a key.
   *
   * Both the omitted and the blank case are driven, separately and by name. They
   * are different bugs: `undefined` comes from a secret that was never created,
   * `""` from `wrangler secret put` accepting an empty value. An implementation
   * that guards `undefined` with a plain falsy check catches both; one that
   * guards with `!== undefined` catches only the first — and the blank case is
   * the one that also matches an absent Authorization header, turning the gate
   * into a welcome mat.
   */
  const UNCONFIGURED_CREDENTIALS: readonly (readonly [string, Partial<Env>])[] =
    [
      ["user omitted", { RESUME_AUTH_USER: undefined as unknown as string }],
      [
        "password omitted",
        { RESUME_AUTH_PASSWORD: undefined as unknown as string },
      ],
      [
        "both omitted",
        {
          RESUME_AUTH_USER: undefined as unknown as string,
          RESUME_AUTH_PASSWORD: undefined as unknown as string,
        },
      ],
      ["user blank", { RESUME_AUTH_USER: "" }],
      ["password blank", { RESUME_AUTH_PASSWORD: "" }],
      ["both blank", { RESUME_AUTH_USER: "", RESUME_AUTH_PASSWORD: "" }],
      ["user whitespace-only", { RESUME_AUTH_USER: "   " }],
      ["password whitespace-only", { RESUME_AUTH_PASSWORD: "\t \n" }],
    ];

  /**
   * THE CREDENTIAL SHAPES AN UNCONFIGURED DEPLOY MUST REFUSE, and the reason
   * there are three of them rather than one.
   *
   * An earlier version of this test drove only `authed()` — a VALID credential —
   * against a blanked secret, and it passed the guard-removal sabotage. It
   * passed for the wrong reason: `"test-resume-user" !== ""` is a mismatch, so
   * the 401 came from the comparison, not from the guard the test claimed to be
   * proving. Deleting the guard changed nothing it could see.
   *
   * The input that actually distinguishes them is an EMPTY credential, because
   * an empty credential MATCHES a blank secret. `no credential` is what a
   * stranger's browser sends on the first request, and `empty credential` is the
   * one-line attack against it. Those two are the reason this array exists; the
   * valid credential is kept only so the refusal is shown to be unconditional.
   */
  const REFUSED_SHAPES: readonly (readonly [string, RequestInit])[] = [
    ["no credential", {}],
    // base64 of ":" — an empty username and an empty password, the exact shape
    // that matches an unset secret if the guard is missing.
    ["empty credential", { headers: { Authorization: "Basic Og==" } }],
    ["valid credential", authed()],
  ];

  for (const [label, override] of UNCONFIGURED_CREDENTIALS) {
    it(`answers 401 and never touches R2 when the ${label}`, async () => {
      const { bucket, reads } = recordingBucket();
      const observed: { shape: string; status: number; challenge: string | null }[] =
        [];

      for (const [shape, init] of REFUSED_SHAPES) {
        const ctx = createExecutionContext();
        const response = await worker.fetch(
          new Request(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), init),
          { ...env, ...override, RESUMES: bucket },
          ctx,
        );
        // Drained before any assertion: an ungated response here carries a live
        // R2 stream, and leaving one open takes the whole file down.
        const body = await response.text();
        await waitOnExecutionContext(ctx);

        expect(body).toBe('{"ok":false,"error":"UNAUTHORIZED"}');
        observed.push({
          shape,
          status: response.status,
          challenge: response.headers.get("WWW-Authenticate"),
        });
      }

      expect(observed).toEqual(
        REFUSED_SHAPES.map(([shape]) => ({
          shape,
          status: 401,
          challenge: RESUME_CHALLENGE,
        })),
      );
      expect(reads).toEqual([]);
    });
  }

  /**
   * The recorder above asserts an EMPTY list, which is worthless unless the
   * recorder can produce a non-empty one. This drives a real, authenticated
   * request through the same spy and pins the key it observed, so "no reads"
   * above means "the Worker did not reach storage" rather than "the spy was
   * never wired up".
   */
  it("records the key when an authenticated request does reach storage", async () => {
    const { bucket, reads } = recordingBucket();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY), authed()),
      { ...env, RESUMES: bucket },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // The stub answers null, so the object is absent and the route 404s — the
    // point is only that the lookup HAPPENED.
    expect(response.status).toBe(404);
    expect(reads).toEqual([STORED_RESUME_KEY]);
  });

  /**
   * The challenge has to be the real thing, or the browser shows no prompt and
   * staff simply see a broken page. Header SET is exact so an accidental
   * `Access-Control-Allow-Origin` on the one response an unauthenticated page
   * can provoke turns this red.
   */
  it("challenges with a browser-usable Basic realm and nothing else", async () => {
    const challenged = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
    );

    expect(challenged.status).toBe(401);
    expect(challenged.headerNames).toEqual(RESUME_401_HEADERS);
    expect(challenged.header("WWW-Authenticate")).toBe(RESUME_CHALLENGE);
  });

  /**
   * ONE REFUSAL, NOT FIVE.
   *
   * A response that differs between "wrong username" and "wrong password" hands
   * an attacker a username oracle: they enumerate the user first, then the
   * password, turning one search space into two much smaller ones. The same
   * applies to distinguishing a malformed header from an absent one.
   *
   * So every rejected shape is compared byte-for-byte against the same
   * baseline — status, complete header set, challenge value and body.
   */
  it("answers every rejected credential shape with a byte-identical refusal", async () => {
    const shapes: readonly (readonly [string, RequestInit])[] = [
      ["absent", {}],
      ["empty Authorization", { headers: { Authorization: "" } }],
      ["scheme only", { headers: { Authorization: "Basic" } }],
      ["not base64", { headers: { Authorization: "Basic !!!not-base64!!!" } }],
      [
        "base64 without a colon",
        { headers: { Authorization: "Basic dGVzdC1yZXN1bWUtdXNlcg==" } },
      ],
      ["bearer token", { headers: { Authorization: "Bearer some-token" } }],
      [
        "digest scheme",
        { headers: { Authorization: 'Digest username="test-resume-user"' } },
      ],
      [
        "wrong username",
        { headers: { Authorization: RESUME_BASIC_WRONG_USER } },
      ],
      [
        "wrong password",
        { headers: { Authorization: RESUME_BASIC_WRONG_PASSWORD } },
      ],
      [
        "correct password, empty username",
        {
          headers: {
            Authorization: "Basic OnRlc3QtcmVzdW1lLXBhc3N3b3JkLTdjMWU1YQ==",
          },
        },
      ],
    ];

    const observed: Record<string, unknown>[] = [];
    for (const [label, init] of shapes) {
      const probe = await probeResume(
        resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
        init,
      );
      observed.push({
        label,
        status: probe.status,
        headerNames: probe.headerNames,
        challenge: probe.header("WWW-Authenticate"),
        body: new TextDecoder().decode(new Uint8Array(probe.bytes)),
      });
    }

    for (const entry of observed) {
      expect({ ...entry, label: undefined }).toEqual({
        label: undefined,
        status: 401,
        headerNames: RESUME_401_HEADERS,
        challenge: RESUME_CHALLENGE,
        body: '{"ok":false,"error":"UNAUTHORIZED"}',
      });
    }

    // Proves the loop ran over every shape rather than zero of them.
    expect(observed.map((entry) => entry.label)).toEqual(
      shapes.map(([label]) => label),
    );
  });

  /**
   * CONSTANT-TIME COMPARISON, ASSERTED ON THE PRIMITIVE THAT PROVIDES IT.
   *
   * A timing measurement is far too noisy to assert on, and behaviourally `===`
   * and a constant-time compare are indistinguishable from outside — which is
   * precisely why swapping one for the other is the sabotage most likely to
   * survive review. So this asserts on WHICH PRIMITIVE RAN.
   *
   * Two calls, not one, and that count is the real assertion. `userOk && passOk`
   * short-circuits: a wrong username skips the password comparison entirely and
   * the response comes back measurably sooner, which is the username oracle
   * rebuilt out of control flow instead of string comparison. The credential
   * used here has a WRONG USERNAME on purpose, so a short-circuiting
   * implementation records one call and fails.
   *
   * The 32-byte assertion pins the other half: both operands are SHA-256
   * digests, so the buffer lengths are fixed regardless of how long the supplied
   * credential is. Feeding raw credentials to `timingSafeEqual` would leak
   * length — and, since it throws on a length mismatch, would leak it as a
   * thrown exception rather than a timing difference.
   */
  it("compares credentials with timingSafeEqual over fixed-width digests, without short-circuiting", async () => {
    const timingSafeEqual = vi.spyOn(timingSafeSubtle, "timingSafeEqual");

    const refused = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
      { headers: { Authorization: RESUME_BASIC_WRONG_USER } },
    );

    expect(refused.status).toBe(401);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const [a, b] of timingSafeEqual.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it("still runs both comparisons when no Authorization header was sent at all", async () => {
    const timingSafeEqual = vi.spyOn(timingSafeSubtle, "timingSafeEqual");

    const refused = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
    );

    expect(refused.status).toBe(401);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  /**
   * An unauthenticated caller must not be able to tell a stored key from an
   * unknown one. If a missing object 404'd before the gate ran, `/resume/<guess>`
   * would become an existence oracle over a PII bucket.
   */
  it("gives an unauthenticated caller no way to tell a stored key from an unknown one", async () => {
    const stored = await probeResume(
      resumeUrl(env.RESUME_HOST, STORED_RESUME_KEY),
    );
    const unknown = await probeResume(
      resumeUrl(env.RESUME_HOST, "00000000-0000-4000-8000-000000000000"),
    );

    expect(stored.status).toBe(401);
    expect({
      status: unknown.status,
      headerNames: unknown.headerNames,
      bytes: unknown.bytes,
    }).toEqual({
      status: stored.status,
      headerNames: stored.headerNames,
      bytes: stored.bytes,
    });
  });

  /**
   * ORDER: HOST-LOCK FIRST, AUTH SECOND.
   *
   * The host lock decides whether this route exists on this hostname at all, so
   * it has to answer before anything credential-shaped runs. Reversed, every
   * hostname that reaches this Worker — `*.workers.dev`, preview URLs,
   * `wrangler dev --remote`, the public submit host — would answer 401 and
   * thereby ADVERTISE a credential-gated PII route to anyone who probed it,
   * complete with a browser prompt to start guessing at.
   *
   * The observable contract is that a wrong host answers identically whether or
   * not correct credentials were supplied: a wrong-host request must not reveal
   * that the credentials would have been accepted.
   */
  it("answers a wrong host identically with and without valid credentials", async () => {
    const withCredential = await probeResume(
      resumeUrl("worker.test", STORED_RESUME_KEY),
      authed(),
    );
    const withoutCredential = await probeResume(
      resumeUrl("worker.test", STORED_RESUME_KEY),
    );

    expect(withCredential.status).toBe(404);
    expect(withCredential.header("WWW-Authenticate")).toBeNull();
    expect({
      status: withoutCredential.status,
      headerNames: withoutCredential.headerNames,
      bytes: withoutCredential.bytes,
    }).toEqual({
      status: withCredential.status,
      headerNames: withCredential.headerNames,
      bytes: withCredential.bytes,
    });
  });

  it("never challenges on a hostname the resume route is not served from", async () => {
    for (const host of ["worker.test", "some-other-host.test"]) {
      const probe = await probeResume(resumeUrl(host, STORED_RESUME_KEY));

      expect(probe.status).toBe(404);
      expect(probe.headerNames).toEqual(["content-type"]);
    }
  });
});

/**
 * `/submit` IS PUBLIC AND MUST STAY PUBLIC.
 *
 * This is the same rule that has governed every slice of this change: a gate
 * that reaches the public endpoint stops lead delivery, and it stops it
 * SILENTLY — the candidate sees a failure, we see nothing, and the lead is gone.
 * Basic Auth is the third mechanism in a row that could have leaked onto this
 * route, so it gets an explicit test rather than an assumption.
 */
describe("POST /submit is never gated by the resume credential", () => {
  it("completes a full submission with no Authorization header at all", async () => {
    const captured = interceptZapier();

    const response = await SELF.fetch(`${ORIGIN}/submit`, {
      method: "POST",
      body: resumeSubmission(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      resumeUrl: expect.stringMatching(
        /^https:\/\/resume-host\.test\/resume\/[0-9a-f-]{36}$/,
      ),
    });
    // The forward is the half that actually delivers the lead, so a 200 alone
    // is not the success signal — this is.
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({
      inquiryType: "Submit Resume",
      // As submitted. The payload contract is frozen and does not normalise;
      // only the erasure hash lower-cases and trims.
      workEmail: "  Jane.Doe@Example.COM  ",
    });
  });

  it("never emits WWW-Authenticate on any /submit response", async () => {
    interceptZapier();

    const responses = [
      await SELF.fetch(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      // Unparseable body — the deploy probe's shape.
      await SELF.fetch(`${ORIGIN}/submit`, { method: "POST" }),
      await SELF.fetch(`${ORIGIN}/submit`, { method: "OPTIONS" }),
    ];

    for (const response of responses) {
      expect(response.headers.get("WWW-Authenticate")).toBeNull();
    }
    expect(responses.map((response) => response.status)).toEqual([
      200, 400, 204,
    ]);
  });

  /**
   * THE DEPLOY-ORDER FAILURE, MADE EXPLICIT.
   *
   * The resume credential is set out of band, in a separate step from the code
   * deploy. Between those two moments the Worker runs with no resume secrets at
   * all — and if that state stopped `/submit` from accepting submissions, the
   * cutover window would silently eat every lead that arrived during it.
   *
   * `/resume` fails closed in this state (asserted above). `/submit` must not
   * notice at all.
   */
  it("delivers a lead while the resume credential is completely unset", async () => {
    const captured = interceptZapier();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/submit`, {
        method: "POST",
        body: resumeSubmission(),
      }),
      {
        ...env,
        RESUME_AUTH_USER: undefined as unknown as string,
        RESUME_AUTH_PASSWORD: undefined as unknown as string,
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({
      inquiryType: "Submit Resume",
    });
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

  // `/resume` is deliberately NOT covered here. It now has a handler, and its
  // reachability, host lock and response contract live in the labelled
  // "route reachability (NOT authorization...)" block above, where a reader
  // cannot mistake a green run for a proof that the Access gate exists.
});
