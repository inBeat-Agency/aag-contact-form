import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFormData,
  submitContactForm,
  SUBMIT_TIMEOUT_MS,
} from "./submit";
import type { ContactFormFields } from "./schema";
import { INQUIRY_TYPES } from "./schema";
import { ZAPIER_PAYLOAD_KEYS } from "../worker/src/payload";

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
    companySize: "51-200",
    estimatedBudget: "$50K – $150K",
    expectedTimeline: "1-3 months",
    message: "We need help with hiring.",
    resume: null,
    website: "",
    ...overrides,
  };
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
        companySize: "",
        estimatedBudget: "",
        expectedTimeline: "",
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
        companySize: "",
        estimatedBudget: "",
        expectedTimeline: "",
        website: "spam",
      }),
      null,
    );

    expect(data.has("title")).toBe(false);
    expect(data.has("company")).toBe(false);
    expect(data.has("phone")).toBe(false);
    expect(data.has("companySize")).toBe(false);
    expect(data.has("estimatedBudget")).toBe(false);
    expect(data.has("expectedTimeline")).toBe(false);
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
    expect(data.get("companySize")).toBe("51-200");
    expect(data.get("estimatedBudget")).toBe("$50K – $150K");
    expect(data.get("expectedTimeline")).toBe("1-3 months");
  });

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

  /** The URL-encoded body the widget actually sent. */
  function lastBody(): URLSearchParams {
    const { body } = lastInit();
    expect(body).toBeInstanceOf(URLSearchParams);
    return body as URLSearchParams;
  }

  async function send(
    fields: Partial<ContactFormFields> = {},
    source: string | null = "src",
  ) {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    return submitContactForm(
      "https://example.test/submit",
      buildFormData(makeFields(fields), source),
      { submittedAt: "2026-07-30T14:18:41.000Z" },
    );
  }

  it("uses a 60s upload-safe timeout by default", () => {
    expect(SUBMIT_TIMEOUT_MS).toBe(60_000);
  });

  it("POSTs a URL-encoded body (not FormData, not JSON) with a signal", async () => {
    await send();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/submit");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // Zapier discards multipart and still answers 200, so FormData here would
    // look like success while dropping the lead.
    expect(init.body).not.toBeInstanceOf(FormData);
    // A JSON string body would need a Content-Type Zapier can't be given.
    expect(typeof init.body).not.toBe("string");
    expect(init.body).toBeInstanceOf(URLSearchParams);
  });

  // THE guard. Setting Content-Type by hand — even to the exact value the
  // browser would pick — makes the request preflighted, and Zapier never
  // answers the OPTIONS. If this test goes red, submissions die in the browser.
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

  it.each(INQUIRY_TYPES)(
    "sends all 15 contract keys for %s, including the empty ones",
    async (inquiryType) => {
      // Deliberately blank every optional field: empty must still ship the key.
      await send({
        inquiryType: inquiryType as ContactFormFields["inquiryType"],
        title: "",
        company: "",
        phone: "",
        companySize: "",
        estimatedBudget: "",
        expectedTimeline: "",
      });

      const body = lastBody();
      expect([...body.keys()].sort()).toEqual([...ZAPIER_PAYLOAD_KEYS].sort());
      for (const key of ZAPIER_PAYLOAD_KEYS) {
        expect(body.has(key), `missing contract key "${key}"`).toBe(true);
        expect(typeof body.get(key), `"${key}" must be a string`).toBe("string");
      }
      expect(body.get("inquiryType")).toBe(inquiryType);
    },
  );

  it("encodes the populated engagement fields and the injected timestamp", async () => {
    await send();

    const body = lastBody();
    expect(body.get("firstName")).toBe("Jane");
    expect(body.get("workEmail")).toBe("jane@company.com");
    expect(body.get("title")).toBe("Head of Talent");
    expect(body.get("estimatedBudget")).toBe("$50K \u2013 $150K");
    expect(body.get("source")).toBe("src");
    expect(body.get("submittedAt")).toBe("2026-07-30T14:18:41.000Z");
  });

  it("defaults submittedAt to the clock when the caller injects nothing", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await submitContactForm(
      "https://example.test/submit",
      buildFormData(makeFields(), "src"),
    );

    const sent = lastBody().get("submittedAt") as string;
    expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(new Date(sent).getTime()).not.toBeNaN();
  });

  it("reports the resume by name with an empty resumeUrl, and never its bytes", async () => {
    const file = new File(["%PDF-1.4 secret resume bytes"], "jane-smith.pdf", {
      type: "application/pdf",
    });

    await send({ inquiryType: "Submit Resume", resume: fileListOf(file) });

    const body = lastBody();
    // Honest signal: "a resume arrived, the file is pending". Not a fake URL.
    expect(body.get("resumeFileName")).toBe("jane-smith.pdf");
    expect(body.get("resumeUrl")).toBe("");

    // The binary must never reach the wire in a URL-encoded body.
    expect(body.has("resume")).toBe(false);
    expect(body.toString()).not.toContain("%25PDF"); // "%PDF", url-encoded
    expect(decodeURIComponent(body.toString())).not.toContain("%PDF");
    expect(decodeURIComponent(body.toString())).not.toContain("secret resume");
  });

  it("resolves 'success' on a resolved ok response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const outcome = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );
    expect(outcome).toBe("success");
  });

  it("resolves 'error' on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const outcome = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );
    expect(outcome).toBe("error");
  });

  it("resolves 'error' on a network rejection without throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const outcome = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );
    expect(outcome).toBe("error");
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
    // The aborted fetch is caught and surfaced as "error", never thrown.
    await expect(promise).resolves.toBe("error");
  });
});
