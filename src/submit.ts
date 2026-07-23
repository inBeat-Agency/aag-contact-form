import type { ContactFormFields } from "./schema";

/** Upload-safe wall-clock default for the submission request. */
export const SUBMIT_TIMEOUT_MS = 60_000;

export type SubmitOutcome = "success" | "error";

/**
 * Build the multipart payload sent to the backend. Fields are flat camelCase
 * keys so the backend contract is simple. Empty optional values are omitted so
 * the server receives a clean payload. The resume File is appended only when
 * present.
 */
export function buildFormData(
  values: ContactFormFields,
  source: string | null,
): FormData {
  const data = new FormData();

  const appendIfPresent = (key: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) data.append(key, trimmed);
  };

  data.append("inquiryType", values.inquiryType);
  data.append("firstName", values.firstName.trim());
  data.append("lastName", values.lastName.trim());
  data.append("workEmail", values.workEmail.trim());
  data.append("message", values.message.trim());

  appendIfPresent("title", values.title);
  appendIfPresent("company", values.company);
  appendIfPresent("phone", values.phone);
  appendIfPresent("companySize", values.companySize);
  appendIfPresent("estimatedBudget", values.estimatedBudget);
  appendIfPresent("expectedTimeline", values.expectedTimeline);

  const resume = values.resume instanceof File ? values.resume : values.resume?.[0];
  if (resume) data.append("resume", resume, resume.name);

  if (source) data.append("source", source);

  return data;
}

/**
 * POST the payload to the endpoint with an AbortController-based timeout.
 * Returns "success" on a 2xx response, "error" otherwise (including network
 * failures and timeouts). Never throws.
 */
export async function submitContactForm(
  endpoint: string,
  formData: FormData,
  timeoutMs = SUBMIT_TIMEOUT_MS,
): Promise<SubmitOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    return response.ok ? "success" : "error";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}
