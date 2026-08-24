import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFormData,
  submitContactForm,
  SUBMIT_TIMEOUT_MS,
} from "./submit";
import type { ContactFormFields } from "./schema";

// A fully-populated fields object; individual tests override what they exercise.
function makeFields(
  overrides: Partial<ContactFormFields> = {},
): ContactFormFields {
  return {
    inquiryType: "Consulting",
    firstName: "Jane",
    lastName: "Smith",
    workEmail: "jane@company.com",
    title: "Head of Talent",
    company: "Acme Inc.",
    phone: "+1 555 000 0000",
    estimatedBudget: "$50K – $150K",
    message: "We need help with hiring.",
    resume: null,
    website: "",
    ...overrides,
  };
}

/** Read a Blob's text. jsdom's File has no `.text()`, so go through FileReader. */
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

// Build a FileList-like object around a single File (jsdom has no constructor).
function fileListOf(file: File): FileList {
  return {
    0: file,
    length: 1,
    item: (index: number) => (index === 0 ? file : null),
    [Symbol.iterator]: function* () {
      yield file;
    },
  } as unknown as FileList;
}

describe("buildFormData", () => {
  it("emits flat camelCase keys for the required fields", () => {
    const data = buildFormData(
      makeFields({
        inquiryType: "General Question",
        title: "",
        company: "",
        phone: "",
        estimatedBudget: "",
      }),
      "webflow-home",
    );

    expect(data.get("inquiryType")).toBe("General Question");
    expect(data.get("firstName")).toBe("Jane");
    expect(data.get("lastName")).toBe("Smith");
    expect(data.get("workEmail")).toBe("jane@company.com");
    expect(data.get("message")).toBe("We need help with hiring.");
    expect(data.get("source")).toBe("webflow-home");
  });

  it("omits empty optional fields and never includes the honeypot", () => {
    const data = buildFormData(
      makeFields({
        inquiryType: "General Question",
        title: "",
        company: "",
        phone: "",
        estimatedBudget: "",
        website: "spam",
      }),
      null,
    );

    expect(data.has("title")).toBe(false);
    expect(data.has("company")).toBe(false);
    expect(data.has("phone")).toBe(false);
    expect(data.has("estimatedBudget")).toBe(false);
    // Honeypot is a transport-layer concern handled by the component, not here.
    expect(data.has("website")).toBe(false);
    // No source passed => no source key.
    expect(data.has("source")).toBe(false);
  });

  it("includes populated business/engagement fields", () => {
    const data = buildFormData(makeFields(), "src");

    expect(data.get("title")).toBe("Head of Talent");
    expect(data.get("company")).toBe("Acme Inc.");
    expect(data.get("phone")).toBe("+1 555 000 0000");
    expect(data.get("estimatedBudget")).toBe("$50K – $150K");
  });

  /**
   * Company Size and Expected Timeline are no longer collected by any inquiry
   * type. The multipart body must not carry them at all — the Worker supplies
   * the two wire-contract keys as empty strings, which is what keeps the Zapier
   * field-mapping picker stable. See `worker/src/payload.ts`.
   *
   * The retired keys are injected here through a cast ON PURPOSE. Dropping them
   * from `ContactFormFields` makes TypeScript the first line of defence, but
   * types are erased at runtime: a stale embed, a cached bundle or a hand-rolled
   * caller can still hand us the old shape. This proves `buildFormData` ignores
   * them rather than merely never being offered them.
   */
  it.each(["Consulting", "Recruitment / Hiring"] as const)(
    "never sends Company Size or Expected Timeline for %s",
    (inquiryType) => {
      const stale = {
        ...makeFields({ inquiryType }),
        companySize: "51-200",
        expectedTimeline: "1-3 months",
      } as ContactFormFields;

      const data = buildFormData(stale, "src");

      expect(data.has("companySize")).toBe(false);
      expect(data.has("expectedTimeline")).toBe(false);
      // Guard the guard: the engagement fields that DID survive still ship.
      expect(data.get("estimatedBudget")).toBe("$50K – $150K");
    },
  );

  it("appends the File under the resume key when present", () => {
    const file = new File(["cv"], "cv.pdf", { type: "application/pdf" });
    const data = buildFormData(
      makeFields({ inquiryType: "Submit Resume", resume: fileListOf(file) }),
      "src",
    );

    const sent = data.get("resume");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("cv.pdf");
  });

  it("does not append a resume key when no file is selected", () => {
    const data = buildFormData(makeFields({ resume: null }), "src");
    expect(data.has("resume")).toBe(false);
  });
});

describe("submitContactForm", () => {
  const fetchMock = vi.fn();

  /** The exact URL the Worker hands back for a stored resume. */
  const WORKER_RESUME_URL =
    "https://resume.test/resume/3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  /** A Worker-shaped success response: 2xx AND an explicit `ok: true`. */
  function workerSuccess(resumeUrl = ""): Response {
    return new Response(JSON.stringify({ ok: true, resumeUrl }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The RequestInit the widget actually handed to fetch. */
  function lastInit(): RequestInit {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return fetchMock.mock.calls[0][1] as RequestInit;
  }

  /** The multipart body the widget actually sent. */
  function lastBody(): FormData {
    const { body } = lastInit();
    expect(body).toBeInstanceOf(FormData);
    return body as FormData;
  }

  async function send(
    fields: Partial<ContactFormFields> = {},
    source: string | null = "src",
  ) {
    fetchMock.mockResolvedValue(workerSuccess());
    return submitContactForm(
      "https://example.test/submit",
      buildFormData(makeFields(fields), source),
    );
  }

  it("uses a 60s upload-safe timeout by default", () => {
    expect(SUBMIT_TIMEOUT_MS).toBe(60_000);
  });

  it("POSTs the FormData instance untouched (not URL-encoded, not JSON)", async () => {
    await send();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/submit");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // The Worker parses multipart. Anything else drops the resume binary.
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("hands fetch the very same FormData object it was given, unwrapped", async () => {
    const built = buildFormData(makeFields(), "src");
    fetchMock.mockResolvedValue(workerSuccess());

    await submitContactForm("https://example.test/submit", built);

    // Identity, not shape: proves nothing re-encoded or copied the body on the
    // way out, which is how the resume binary used to get lost.
    expect(lastInit().body).toBe(built);
  });

  // THE guard. Setting Content-Type by hand — even to the exact value the
  // browser would pick — makes the request preflighted. It survives the move to
  // the Worker for a different reason than it was written for: multipart is
  // CORS-safelisted, so leaving the header alone means no OPTIONS ever fires,
  // and the browser writes the multipart boundary itself. Set it here and the
  // boundary is missing, so the Worker cannot parse a single field.
  it("never sets a Content-Type header (browser must set it from the body)", async () => {
    await send();

    const init = lastInit();
    expect(init.headers).toBeUndefined();

    // Belt and braces: no header-ish key smuggled in under another name.
    const headerish = Object.entries(init).filter(([key]) =>
      /header|content.?type/i.test(key),
    );
    expect(headerish).toEqual([]);
  });

  it("sends the typed engagement fields as multipart parts", async () => {
    await send();

    const body = lastBody();
    expect(body.get("firstName")).toBe("Jane");
    expect(body.get("workEmail")).toBe("jane@company.com");
    expect(body.get("title")).toBe("Head of Talent");
    expect(body.get("estimatedBudget")).toBe("$50K \u2013 $150K");
    expect(body.get("source")).toBe("src");
  });

  it("carries the resume File itself, bytes intact, to the Worker", async () => {
    const file = new File(["%PDF-1.4 secret resume bytes"], "jane-smith.pdf", {
      type: "application/pdf",
    });

    await send({ inquiryType: "Submit Resume", resume: fileListOf(file) });

    const sent = lastBody().get("resume");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("jane-smith.pdf");
    expect((sent as File).type).toBe("application/pdf");
    // The bytes must survive the trip: this is the whole reason for multipart.
    expect(await readText(sent as File)).toBe("%PDF-1.4 secret resume bytes");
  });

  it("leaves the wire contract to the Worker: no flat payload keys are sent", async () => {
    await send({
      inquiryType: "Submit Resume",
      resume: fileListOf(new File(["cv"], "cv.pdf", { type: "application/pdf" })),
    });

    const body = lastBody();
    // `resumeUrl`, `resumeFileName` and `submittedAt` are produced server-side by
    // worker/src/payload.ts. The widget inventing them is what shipped an empty
    // `resumeUrl` to Zapier for the whole interim.
    expect(body.has("resumeUrl")).toBe(false);
    expect(body.has("resumeFileName")).toBe(false);
    expect(body.has("submittedAt")).toBe(false);
  });

  /* =========================================================================
   * The success contract (design §4 C2).
   *
   * This project exists because a 2xx from an unverified party was treated as
   * proof of delivery. `response.ok` says a response arrived. `ok: true` says
   * OUR Worker produced it. Success requires BOTH, and nothing here is
   * tolerant: a missing `ok` is an error, not a default.
   * ========================================================================= */

  it("reports error when a 2xx carries an HTML body", async () => {
    fetchMock.mockResolvedValue(
      new Response("<!doctype html><h1>Success</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({ outcome: "error" });
  });

  it("reports error when a 2xx body says ok:false", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "STORAGE_FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({ outcome: "error" });
  });

  it("reports error when a 2xx body is valid JSON with no ok field", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "success", resumeUrl: "https://x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    // A missing `ok` is NOT a default-to-success. Zapier's own 200 body is
    // {"status":"success"} — exactly this shape.
    expect(result).toEqual({ outcome: "error" });
  });

  it("reports success with the Worker's resumeUrl when the body says ok:true", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, resumeUrl: WORKER_RESUME_URL }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({
      outcome: "success",
      resumeUrl: WORKER_RESUME_URL,
    });
  });

  it("reports error when ok:true arrives on a 500", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, resumeUrl: WORKER_RESUME_URL }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    // Both conditions are required, in both directions.
    expect(result).toEqual({ outcome: "error" });
  });

  it.each([
    ["a JSON null body", "null"],
    ["a JSON array body", '[{"ok":true}]'],
    ["a bare JSON true", "true"],
    ["a bare JSON string", '"ok"'],
  ])("reports error for %s on a 2xx", async (_label, raw) => {
    fetchMock.mockResolvedValue(
      new Response(raw, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({ outcome: "error" });
  });

  it("reports success with an empty resumeUrl when the Worker omits one", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    // A text-only inquiry has no resume, so no URL. Still a real success.
    expect(result).toEqual({ outcome: "success", resumeUrl: "" });
  });

  it("reports success with an empty resumeUrl when the Worker sends a non-string one", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, resumeUrl: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({ outcome: "success", resumeUrl: "" });
  });

  it("reports error on a network rejection without throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const result = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(result).toEqual({ outcome: "error" });
  });

  it("aborts the request when the configured timeout elapses", async () => {
    vi.useFakeTimers();

    // Resolve only when the abort signal fires, mirroring fetch's real behavior
    // so we can prove the timeout path triggers an abort.
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    const promise = submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );

    expect(capturedSignal?.aborted).toBe(false);

    // Advance past the timeout; the AbortController should fire.
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);

    expect(capturedSignal?.aborted).toBe(true);
    // The aborted fetch is caught and surfaced as an error, never thrown.
    await expect(promise).resolves.toEqual({ outcome: "error" });
  });
});
