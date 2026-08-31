import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { sendResumeEmail, type ResumeEmailOutcome } from "./resume-email";

/**
 * Runtime tests for the resume delivery email, executed inside workerd by
 * `@cloudflare/vitest-pool-workers` (see `vitest.worker.config.ts`).
 *
 * Nothing here reaches Resend. `disableNetConnect()` makes any unmatched
 * outbound request throw, so a test that forgets to intercept fails loudly
 * instead of quietly posting a fixture at the real API.
 *
 * EVERY EXPECTED VALUE IN THIS FILE IS A HAND-WRITTEN LITERAL. None is imported
 * from the module under test and none is rebuilt with an expression the
 * implementation also evaluates. This repo has shipped that defect twice —
 * `${RESUME_URL_BASE}/${key}` in an assertion, and a fixture that smuggled
 * `/resume` into a binding — and both times a wrong implementation produced an
 * equally wrong expectation and the comparison passed. The endpoint, the sender,
 * the recipient and the subject prefix are a published contract with a DNS
 * record and an inbox behind them; they are typed out again on purpose, and
 * changing one has to be a deliberate edit here.
 */

/** The API key never leaves this file, and several tests scan for it by value. */
const API_KEY = "re_test_key_2f7c91ad";

const RESEND_ORIGIN = "https://api.resend.com";
const RESEND_PATH = "/emails";

/** Written out by hand. The contract, not `RESUME_EMAIL_FROM` re-read. */
const EXPECTED_FROM = "AAG Website <resumes@forms.alphaapexgroup.com>";
const EXPECTED_TO = "hello@alphaapexgroup.com";
const EXPECTED_SUBJECT_PREFIX = "Resume submission: ";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // DOCX is a ZIP container
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.assertNoPendingInterceptors();
});

type CapturedSend = {
  body?: string;
  headers?: Record<string, string>;
};

function interceptResend(status = 200, replyBody = '{"id":"re_123"}') {
  const captured: CapturedSend = {};
  fetchMock
    .get(RESEND_ORIGIN)
    .intercept({ path: RESEND_PATH, method: "POST" })
    .reply(status, (options) => {
      captured.body = options.body as string;
      captured.headers = options.headers as Record<string, string>;
      return replyBody;
    });
  return captured;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  const hit = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return hit?.[1] ?? "";
}

type ResendPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; content: string }[];
};

function sentPayload(captured: CapturedSend): ResendPayload {
  return JSON.parse(captured.body!) as ResendPayload;
}

/**
 * Build a File whose bytes are REAL and unique per test.
 *
 * The trailing marker matters: an implementation that mailed a placeholder, a
 * truncated head, or the first chunk twice would still produce well-formed
 * base64 starting with the right magic bytes. Only a full round-trip comparison
 * against distinct trailing bytes can see that.
 */
function makeFile(name: string, type: string, magic: number[], size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(magic, 0);
  for (let index = magic.length; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }
  return { file: new File([bytes], name, { type }), bytes };
}

function message(file: File) {
  return {
    candidateName: "Jane Doe",
    candidateEmail: "jane.doe@example.com",
    submittedAt: "2026-08-31T10:20:30.000Z",
    file,
  };
}

/** Decode base64 back to the bytes it claims to carry, without the encoder. */
function fromBase64(value: string): number[] {
  return [...atob(value)].map((char) => char.charCodeAt(0));
}

describe("sendResumeEmail - the outbound request contract", () => {
  it("posts to the Resend send endpoint, and to nothing else", async () => {
    const seen: { url: string; method: string }[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        seen.push({
          url: String(input),
          method: String(init?.method ?? "GET"),
        });
        return new Response('{"id":"re_123"}', { status: 200 });
      });

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));
    fetchSpy.mockRestore();

    // The URL is a literal, not `RESEND_ENDPOINT`. A typo'd host in the module
    // would otherwise produce a matching typo'd expectation.
    expect(seen).toEqual([
      { url: "https://api.resend.com/emails", method: "POST" },
    ]);
  });

  it("authenticates with a bearer token and labels the body as JSON", async () => {
    const captured = interceptResend();

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));

    expect(headerValue(captured.headers, "authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(headerValue(captured.headers, "content-type")).toContain(
      "application/json",
    );
  });

  /**
   * The same control `forwardToZapier` applies, for a stronger reason.
   *
   * A custom `Authorization` header is NOT stripped on a cross-origin hop, so a
   * followed redirect hands the Resend API key — and a candidate's entire CV —
   * to whatever the `Location` names. `fetchMock` does not implement redirect
   * following, so the POLICY on the outbound request is the only thing this
   * harness can actually observe, and it is the whole fix.
   */
  it("asks fetch NOT to follow redirects", async () => {
    const outbound: RequestInit[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        outbound.push(init ?? {});
        return new Response('{"id":"re_123"}', { status: 200 });
      });

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));
    fetchSpy.mockRestore();

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.redirect).toBe("manual");
  });

  /**
   * THE SENDER AND RECIPIENT ARE FIXED, AND NEITHER IS DERIVED FROM INPUT.
   *
   * `from` must sit inside the DNS-verified domain or Resend refuses the send;
   * `to` is the one inbox AAG asked for. An implementation that echoed the
   * candidate's address into either would mail a stranger's CV to the stranger,
   * so both are compared against literals rather than against anything the
   * message carried.
   */
  it("sends from the verified sender to the fixed recipient", async () => {
    const captured = interceptResend();

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));

    const payload = sentPayload(captured);
    expect(payload.from).toBe(EXPECTED_FROM);
    expect(payload.to).toEqual([EXPECTED_TO]);
  });

  it("keeps the sender and recipient fixed no matter what the candidate typed", async () => {
    const captured = interceptResend();

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, {
      candidateName: "Attacker",
      candidateEmail: "attacker@evil.test",
      submittedAt: "2026-08-31T10:20:30.000Z",
      file,
    });

    const payload = sentPayload(captured);
    expect(payload.from).toBe(EXPECTED_FROM);
    expect(payload.to).toEqual([EXPECTED_TO]);
    expect(captured.body).not.toContain("evil.test<");
  });

  /**
   * PLAIN TEXT ONLY. An HTML part would give a candidate-supplied name a markup
   * context to break out of, and there is no reason to have one: this message
   * carries a file and four facts.
   */
  it("sends a plain-text body with no HTML part and no links", async () => {
    const captured = interceptResend();

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));

    const payload = sentPayload(captured);
    expect(payload.text).toContain("Jane Doe");
    expect(payload.text).toContain("jane.doe@example.com");
    expect(Object.keys(payload)).not.toContain("html");
    expect(payload.text).not.toContain("http://");
    expect(payload.text).not.toContain("https://");
  });

  it("puts the candidate name in the subject behind a stable prefix", async () => {
    const captured = interceptResend();

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));

    expect(sentPayload(captured).subject).toBe(
      `${EXPECTED_SUBJECT_PREFIX}Jane Doe`,
    );
  });
});

describe("sendResumeEmail - the attachment survives the round trip", () => {
  /**
   * THE LOAD-BEARING TEST OF THIS FILE.
   *
   * AAG asked for the ORIGINAL file, not a rendering of it, so the assertion is
   * a full decode of what went on the wire compared against the exact bytes that
   * went in. A truncating, re-encoding or placeholder implementation produces
   * valid base64 with the right leading magic bytes and fails only here.
   *
   * The decode uses `atob`, which is not the encoder the module runs.
   */
  const FORMATS: [string, string, string, number[]][] = [
    ["PDF", "Jane-Doe-CV.pdf", "application/pdf", PDF_MAGIC],
    [
      "DOCX",
      "Jane-Doe-CV.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ZIP_MAGIC,
    ],
    ["legacy DOC", "Jane-Doe-CV.doc", "application/msword", OLE2_MAGIC],
  ];

  it.each(FORMATS)(
    "attaches a %s under its original name, byte for byte",
    async (_label, name, type, magic) => {
      const captured = interceptResend();
      const { file, bytes } = makeFile(name, type, magic, 4096);

      const outcome = await sendResumeEmail(API_KEY, message(file));

      expect(outcome).toBe("delivered");
      const [attachment] = sentPayload(captured).attachments;
      expect(attachment!.filename).toBe(name);
      expect(fromBase64(attachment!.content)).toEqual([...bytes]);
    },
  );

  it("attaches exactly one file", async () => {
    const captured = interceptResend();
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 128);

    await sendResumeEmail(API_KEY, message(file));

    expect(sentPayload(captured).attachments).toHaveLength(1);
  });

  /**
   * The chunked encoder exists because `String.fromCharCode(...bytes)` on a
   * 10MB resume overflows the call stack. A file spanning several windows —
   * and one byte past a window boundary — is what proves the walk reassembles
   * in order rather than dropping or repeating a chunk.
   */
  it("encodes a multi-megabyte file without losing or reordering a chunk", async () => {
    const captured = interceptResend();
    const { file, bytes } = makeFile(
      "big.pdf",
      "application/pdf",
      PDF_MAGIC,
      0x8000 * 3 + 1,
    );

    const outcome = await sendResumeEmail(API_KEY, message(file));

    expect(outcome).toBe("delivered");
    expect(fromBase64(sentPayload(captured).attachments[0]!.content)).toEqual([
      ...bytes,
    ]);
  });

  /**
   * HEADER INJECTION. The file name becomes a MIME header at Resend's end, and
   * a CR or LF inside it splits the header block. Control characters are the
   * only thing removed: an ordinary name must survive untouched, which the
   * round-trip tests above assert.
   */
  it("strips control characters out of a hostile file name and keeps the rest", async () => {
    const captured = interceptResend();
    const { file } = makeFile(
      "ev\r\nBcc: attacker@evil.test\r\nil.pdf",
      "application/pdf",
      PDF_MAGIC,
      64,
    );

    await sendResumeEmail(API_KEY, message(file));

    // Each control character becomes one space, so the CRLF pairs above leave
    // two. Written out exactly rather than normalised: collapsing runs would be
    // a second transformation nobody asked for, and this literal is what proves
    // the module does not quietly perform one.
    const payload = sentPayload(captured);
    expect(payload.attachments[0]!.filename).toBe(
      "ev  Bcc: attacker@evil.test  il.pdf",
    );
    expect(payload.attachments[0]!.filename).not.toContain("\r");
    expect(payload.attachments[0]!.filename).not.toContain("\n");
  });

  it("strips control characters out of a hostile candidate name in the subject", async () => {
    const captured = interceptResend();
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

    await sendResumeEmail(API_KEY, {
      candidateName: "Jane\r\nBcc: attacker@evil.test",
      candidateEmail: "jane.doe@example.com",
      submittedAt: "2026-08-31T10:20:30.000Z",
      file,
    });

    const subject = sentPayload(captured).subject;
    expect(subject).not.toContain("\r");
    expect(subject).not.toContain("\n");
    expect(subject).toBe(
      `${EXPECTED_SUBJECT_PREFIX}Jane  Bcc: attacker@evil.test`,
    );
  });

  it("still names the attachment when the file name sanitises away to nothing", async () => {
    const captured = interceptResend();
    const { file } = makeFile("\r\n\t", "application/pdf", PDF_MAGIC, 64);

    await sendResumeEmail(API_KEY, {
      candidateName: "\u0001",
      candidateEmail: "jane.doe@example.com",
      submittedAt: "2026-08-31T10:20:30.000Z",
      file,
    });

    const payload = sentPayload(captured);
    expect(payload.attachments[0]!.filename).toBe("resume");
    expect(payload.subject).toBe(`${EXPECTED_SUBJECT_PREFIX}candidate`);
  });
});

describe("sendResumeEmail - every ending is a safe, fixed verdict", () => {
  /**
   * THE PRESENCE OF A SUCCESS SIGNAL, FIRST. Every failure assertion below is
   * satisfied by a function that always reports failure, so the accepted case is
   * pinned before any of them.
   */
  it("reports delivered when Resend accepts the message", async () => {
    interceptResend(200);
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

    await expect(sendResumeEmail(API_KEY, message(file))).resolves.toBe(
      "delivered",
    );
  });

  /**
   * A 4xx from Resend echoes back the payload it refused — the candidate's name,
   * their address, and the base64 of their CV. A 5xx can carry request ids and
   * infrastructure detail. A 3xx is a redirect we refuse to follow. All three
   * collapse to one word, because the alternative is a log line built out of a
   * response body nobody controls.
   */
  const REFUSALS: [string, number, string][] = [
    ["401 an invalid API key", 401, '{"message":"API key is invalid"}'],
    ["403 an unverified sender domain", 403, '{"message":"domain not verified"}'],
    ["413 a payload Resend considers too large", 413, "too large"],
    ["422 a rejected field", 422, '{"message":"attachment too big"}'],
    ["429 a throttled sender", 429, '{"message":"rate limited"}'],
    ["500 an upstream fault", 500, "resend exploded"],
    ["503 an outage", 503, "unavailable"],
    ["302 a redirect", 302, ""],
  ];

  it.each(REFUSALS)(
    "reports rejected, and nothing else, for %s",
    async (_label, status, replyBody) => {
      interceptResend(status, replyBody);
      const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

      const outcome: ResumeEmailOutcome = await sendResumeEmail(
        API_KEY,
        message(file),
      );

      expect(outcome).toBe("rejected");
      // The verdict cannot carry the body, the status, or the key: it is one
      // of four fixed strings chosen in the module.
      expect(outcome).not.toContain(String(status));
      expect(replyBody).not.toContain(outcome);
    },
  );

  it("reports errored when the network call throws", async () => {
    const poisoned = new Error(
      `connect ECONNREFUSED api.resend.com ${API_KEY} jane.doe@example.com`,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(poisoned));

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    const outcome = await sendResumeEmail(API_KEY, message(file));
    fetchSpy.mockRestore();

    expect(outcome).toBe("errored");
  });

  /**
   * A malformed or hostile response body must never be parsed, echoed or
   * inspected. The verdict comes from the STATUS alone, so a 200 carrying
   * nonsense is still a delivery and a 500 carrying valid JSON is still a
   * refusal.
   */
  it("reads the verdict from the status, never from the response body", async () => {
    interceptResend(200, "<html>not json at all");
    const first = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await expect(sendResumeEmail(API_KEY, message(first.file))).resolves.toBe(
      "delivered",
    );

    interceptResend(500, '{"id":"re_123"}');
    const second = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await expect(sendResumeEmail(API_KEY, message(second.file))).resolves.toBe(
      "rejected",
    );
  });

  /**
   * FAIL CLOSED ON THE EMAIL, AND ONLY ON THE EMAIL.
   *
   * An unset Worker secret arrives as `undefined` and a blank one is what
   * `wrangler secret put` stores for an empty value. Interpolating either into
   * the bearer header would POST a candidate's entire CV at Resend as an
   * anonymous request. Nothing is sent, and `disableNetConnect()` is what proves
   * it: an outbound call here would throw and come back as `errored` instead.
   */
  it.each([
    ["unset", ""],
    ["whitespace only", "   \n\t "],
  ])(
    "sends nothing at all and reports unconfigured when the key is %s",
    async (_label, key) => {
      const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

      await expect(sendResumeEmail(key, message(file))).resolves.toBe(
        "unconfigured",
      );
    },
  );

  /**
   * "NEVER THROWS" IS A RUNTIME PROMISE, AND THE TYPE CANNOT KEEP IT.
   *
   * The caller reads this key off a Worker binding, and a binding is whatever
   * the platform hands over — an unset secret arrives as `undefined` however the
   * parameter is declared. The guard used to sit OUTSIDE the try, so
   * `undefined.trim()` would have thrown a TypeError out of a function whose
   * caller has already answered the candidate 200, escaping into the router as
   * an unhandled rejection.
   *
   * These inputs are only reachable by a caller that skipped type-checking,
   * which is exactly the caller a total function has to survive. `undefined` and
   * `null` are the shapes an ABSENT binding actually takes, so they must land on
   * `unconfigured` — and must RESOLVE, which is what `rejects` would catch.
   */
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])(
    "resolves to unconfigured instead of throwing when the key is %s",
    async (_label, key) => {
      const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

      await expect(
        sendResumeEmail(key as unknown as string, message(file)),
      ).resolves.toBe("unconfigured");
    },
  );

  /**
   * A non-string that coerces to something NON-EMPTY is a present key, not an
   * absent one, and is attempted rather than skipped. That is the honest
   * reading: the guard's job is to refuse a blank credential, not to police
   * types the signature already declares.
   *
   * What matters here is totality. Each of these must RESOLVE to a member of the
   * enum instead of rejecting. They land on `errored` because no interceptor is
   * registered and `disableNetConnect()` turns the attempt into a throw — which
   * is precisely the branch being proved to be caught.
   */
  it.each([
    ["a number", 0],
    ["an object", {}],
  ])("resolves rather than throwing when the key is %s", async (_label, key) => {
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

    const outcome = await sendResumeEmail(
      key as unknown as string,
      message(file),
    );

    expect(["delivered", "rejected", "errored", "unconfigured"]).toContain(
      outcome,
    );
    expect(outcome).toBe("errored");
  });

  /**
   * A hostile `toString` is the one shape that reaches the guard and still
   * throws. It must be caught rather than escaping, and `errored` is the honest
   * verdict: unlike the cases above, this one got far enough that "we never
   * looked at a key" would be a lie.
   */
  it("resolves rather than throwing when coercing the key itself throws", async () => {
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    };
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

    await expect(
      sendResumeEmail(hostile as unknown as string, message(file)),
    ).resolves.toBe("errored");
  });

  /**
   * The recorder above asserts a refusal, which is worthless unless a real call
   * would have been observable. This drives the same harness with a key present
   * and requires the call to happen.
   */
  it("does send when a key IS present, so the refusal above means refusal", async () => {
    const seen: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        seen.push(String(input));
        return new Response('{"id":"re_123"}', { status: 200 });
      });

    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(file));
    fetchSpy.mockRestore();

    expect(seen).toEqual(["https://api.resend.com/emails"]);
  });
});

describe("sendResumeEmail - the API key never travels anywhere but the header", () => {
  it("keeps the key out of the request body", async () => {
    const captured = interceptResend();
    const { file } = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);

    await sendResumeEmail(API_KEY, message(file));

    expect(captured.body).not.toContain(API_KEY);
  });

  /**
   * The module must not log at all. `console.error(err)` on the catch branch
   * would put the endpoint, the bearer header and the rejected payload into
   * output — the exact failure the Worker's log allowlist exists to forbid, one
   * module out of its reach.
   */
  it("writes nothing to the console on any path", async () => {
    const calls: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }

    interceptResend(200);
    const ok = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(ok.file));

    interceptResend(401, `{"message":"invalid key ${API_KEY}"}`);
    const refused = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail(API_KEY, message(refused.file));

    const thrown = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(new Error(`boom ${API_KEY}`)));
    await sendResumeEmail(API_KEY, message(thrown.file));
    fetchSpy.mockRestore();

    const unconfigured = makeFile("cv.pdf", "application/pdf", PDF_MAGIC, 64);
    await sendResumeEmail("", message(unconfigured.file));

    expect(calls).toEqual([]);
  });
});
