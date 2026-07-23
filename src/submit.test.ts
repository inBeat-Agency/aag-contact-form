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
    companySize: "51-200",
    estimatedBudget: "$30k - $50k",
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
    expect(data.get("estimatedBudget")).toBe("$30k - $50k");
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

  it("POSTs the FormData (not JSON) to the endpoint with a signal", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const body = buildFormData(makeFields(), "src");

    await submitContactForm("https://example.test/submit", body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/submit");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves 'success' on a resolved ok response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const outcome = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );
    expect(outcome).toBe("success");
  });

  it("resolves 'error' on a network rejection without throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const outcome = await submitContactForm(
      "https://example.test/submit",
      new FormData(),
    );
    expect(outcome).toBe("error");
  });

  it("aborts the request when the 15s timeout elapses", async () => {
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
