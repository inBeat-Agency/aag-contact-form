import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildFormData } from "../../src/submit";
import { BUDGETS, INQUIRY_TYPES } from "../../src/schema";
import type { ContactFormFields } from "../../src/schema";
import {
  toZapierPayload,
  ZAPIER_PAYLOAD_KEYS,
  type ZapierPayload,
} from "./payload";

/**
 * Contract test for the widget -> Zapier transform.
 *
 * The input is built with the widget's real `buildFormData()`, never a
 * hand-rolled FormData. That is the whole point: if someone renames, drops or
 * adds a field in the widget and forgets the Worker, this suite goes red.
 *
 * There is no network here and there must never be. The transform is pure, and
 * the fixtures in `worker/fixtures/` are the artifact the backend team reads.
 */

const FIXTURE_NAMES = [
  "general-question",
  "consulting",
  "recruitment-hiring",
  "submit-resume",
] as const;

type FixtureName = (typeof FIXTURE_NAMES)[number];

// Resolved from the project root, matching src/bundle.test.ts. The jsdom
// environment rewrites `import.meta.url` to the document origin, so a
// URL-relative lookup would resolve outside the repo.
function fixturePath(name: FixtureName): string {
  return resolve(process.cwd(), "worker/fixtures", `${name}.json`);
}

function readFixtureRaw(name: FixtureName): string {
  return readFileSync(fixturePath(name), "utf8");
}

function readFixture(name: FixtureName): ZapierPayload {
  return JSON.parse(readFixtureRaw(name)) as ZapierPayload;
}

/**
 * Rebuild the widget-side form state that would have produced a fixture, so the
 * sample data lives in exactly one place: the fixture file itself.
 */
function widgetFieldsFor(
  fixture: ZapierPayload,
  resume: File | null = null,
): ContactFormFields {
  return {
    inquiryType: fixture.inquiryType as ContactFormFields["inquiryType"],
    firstName: fixture.firstName,
    lastName: fixture.lastName,
    workEmail: fixture.workEmail,
    title: fixture.title,
    company: fixture.company,
    phone: fixture.phone,
    estimatedBudget: fixture.estimatedBudget,
    message: fixture.message,
    resume,
    website: "", // honeypot, never transported
  };
}

/** The resume the candidate would have attached, per the Submit Resume fixture. */
function resumeFileFor(fixture: ZapierPayload): File | null {
  if (!fixture.resumeFileName) return null;
  return new File(["%PDF-1.4 sample resume"], fixture.resumeFileName, {
    type: "application/pdf",
  });
}

/** Run a fixture end to end: widget form state -> FormData -> Zapier payload. */
function transformFixture(fixture: ZapierPayload): ZapierPayload {
  const formData = buildFormData(
    widgetFieldsFor(fixture, resumeFileFor(fixture)),
    fixture.source,
  );

  return toZapierPayload(formData, {
    // The Worker only knows these after it has uploaded the file.
    resumeUrl: fixture.resumeUrl || undefined,
    resumeFileName: fixture.resumeFileName || undefined,
    submittedAt: fixture.submittedAt,
  });
}

describe("toZapierPayload", () => {
  describe.each(FIXTURE_NAMES)("%s", (name) => {
    const fixture = readFixture(name);

    it("reproduces the golden fixture from the widget's own FormData", () => {
      expect(transformFixture(fixture)).toStrictEqual(fixture);
    });

    it("emits all 15 contract keys, in contract order", () => {
      expect(Object.keys(transformFixture(fixture))).toEqual([
        ...ZAPIER_PAYLOAD_KEYS,
      ]);
    });

    it("emits string values only — no undefined, null, number or object", () => {
      for (const [key, value] of Object.entries(transformFixture(fixture))) {
        expect(typeof value, `${key} must be a string`).toBe("string");
      }
    });

    it("covers every text field the widget actually sends", () => {
      const formData = buildFormData(
        widgetFieldsFor(fixture, resumeFileFor(fixture)),
        fixture.source,
      );

      // Anything the widget sends as text must have a home in the payload.
      // A File entry (the resume) is intentionally out of scope here — the
      // Worker uploads it and reports back through resumeUrl/resumeFileName.
      for (const [key, value] of formData.entries()) {
        if (typeof value !== "string") continue;
        expect(
          ZAPIER_PAYLOAD_KEYS as readonly string[],
          `widget sends "${key}" but the Zapier contract has no such key`,
        ).toContain(key);
      }
    });
  });

  it("keeps inapplicable fields as empty strings rather than dropping them", () => {
    // Zapier builds its field-mapping picker from the sample it received, so a
    // General Question must still advertise the engagement fields.
    const payload = transformFixture(readFixture("general-question"));

    expect(payload).toMatchObject({
      title: "",
      company: "",
      phone: "",
      companySize: "",
      estimatedBudget: "",
      expectedTimeline: "",
      resumeUrl: "",
      resumeFileName: "",
    });
    expect(Object.keys(payload)).toHaveLength(ZAPIER_PAYLOAD_KEYS.length);
  });

  /**
   * The engagement flows are the ones that USED to populate these two keys.
   * Now that the widget no longer collects them, the transform must still coin
   * them as empty strings so the Zapier mapping keeps resolving.
   */
  it.each(["consulting", "recruitment-hiring"] as const)(
    "%s still emits companySize and expectedTimeline as empty strings",
    (name) => {
      const payload = transformFixture(readFixture(name));

      expect(payload.companySize).toBe("");
      expect(payload.expectedTimeline).toBe("");
      // Guard the guard: this really is an engagement payload, not a blank one.
      expect(payload.title).not.toBe("");
      expect(payload.company).not.toBe("");
      expect(Object.keys(payload)).toHaveLength(ZAPIER_PAYLOAD_KEYS.length);
    },
  );

  /**
   * The retirement contract is about the WIRE, not about the current widget.
   * After a deploy, a cached copy of the previous bundle — CDN edge or browser
   * — keeps POSTing `companySize` and `expectedTimeline`, and any value that
   * survived the transform would land in the client's live Zap as data the form
   * no longer collects.
   *
   * The FormData here is hand-rolled on purpose. Every other case in this file
   * goes through `buildFormData()`, which already omits both keys, so it can
   * only ever prove they are absent — never that a supplied value is dropped.
   */
  it("pins the retired keys to empty even when the submission supplies them", () => {
    const formData = new FormData();
    formData.set("inquiryType", "Consulting");
    formData.set("firstName", "Felipe");
    formData.set("lastName", "Test");
    formData.set("workEmail", "felipe.test+stale-bundle@example.com");
    formData.set("title", "TEST TITLE");
    formData.set("company", "TEST COMPANY (DO NOT CONTACT)");
    formData.set("phone", "+1 (555) 555-0100");
    formData.set("estimatedBudget", "$50K \u2013 $150K");
    formData.set("message", "[TEST DATA] Sent by a stale cached widget bundle.");
    // The retired pair, exactly as the previous bundle used to send it.
    formData.set("companySize", "201-500 employees");
    formData.set("expectedTimeline", "1-3 months");

    // Guard the guard: the input really does carry the retired values.
    expect(formData.get("companySize")).toBe("201-500 employees");
    expect(formData.get("expectedTimeline")).toBe("1-3 months");

    const payload = toZapierPayload(formData, {
      submittedAt: "2026-07-30T14:18:41.000Z",
    });

    expect(payload.companySize).toBe("");
    expect(payload.expectedTimeline).toBe("");

    // The lead itself must still go through: a stale embed is a real customer,
    // so the two retired values are discarded, never the submission.
    expect(payload.firstName).toBe("Felipe");
    expect(payload.workEmail).toBe("felipe.test+stale-bundle@example.com");
    expect(payload.estimatedBudget).toBe("$50K \u2013 $150K");
    expect(Object.keys(payload)).toEqual([...ZAPIER_PAYLOAD_KEYS]);
  });

  it("never leaks the resume File into the payload", () => {
    const fixture = readFixture("submit-resume");
    const file = resumeFileFor(fixture);
    const formData = buildFormData(widgetFieldsFor(fixture, file), fixture.source);

    // Guard the guard: the input really does carry the binary.
    expect(formData.get("resume")).toBeInstanceOf(File);

    // No upload happened, so the Worker supplies nothing beyond the timestamp.
    const payload = toZapierPayload(formData, {
      submittedAt: fixture.submittedAt,
    });

    expect("resume" in payload).toBe(false);
    expect(payload.resumeUrl).toBe("");
    expect(payload.resumeFileName).toBe("");
    expect(Object.values(payload).every((v) => typeof v === "string")).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("%PDF");
  });

  it("takes submittedAt from options, never from the clock", () => {
    const fixture = readFixture("consulting");
    const formData = buildFormData(widgetFieldsFor(fixture), fixture.source);

    const payload = toZapierPayload(formData, {
      submittedAt: "1999-12-31T23:59:59.000Z",
    });

    expect(payload.submittedAt).toBe("1999-12-31T23:59:59.000Z");
  });
});

describe("golden fixtures", () => {
  it.each(FIXTURE_NAMES)(
    "%s stays pretty-printed with 2-space indent and contract key order",
    (name) => {
      // These files are the contract artifact the backend team reads, so the
      // formatting is part of the deliverable, not incidental.
      const raw = readFixtureRaw(name);
      expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      expect(Object.keys(JSON.parse(raw) as ZapierPayload)).toEqual([
        ...ZAPIER_PAYLOAD_KEYS,
      ]);
    },
  );

  it.each(FIXTURE_NAMES)("%s only uses enum values from src/schema.ts", (name) => {
    const fixture = readFixture(name);

    expect(INQUIRY_TYPES as readonly string[]).toContain(fixture.inquiryType);

    // Optional selects are either unset ("") or an exact schema option.
    if (fixture.estimatedBudget) {
      expect(BUDGETS as readonly string[]).toContain(fixture.estimatedBudget);
    }
  });

  /**
   * Company Size and Expected Timeline are no longer collected by ANY inquiry
   * type, but they stay on the wire as constant empty strings. Zapier builds
   * its field-mapping picker from whichever sample payload it last received, so
   * dropping the keys would silently break the client's live Zap. Every fixture
   * must therefore still carry both, and always empty.
   */
  it.each(FIXTURE_NAMES)("%s carries the retired keys as empty strings", (name) => {
    const fixture = readFixture(name);

    for (const key of ["companySize", "expectedTimeline"] as const) {
      expect(Object.keys(fixture)).toContain(key);
      expect(fixture[key]).toBe("");
    }
  });

  it("uses the EN DASH in budget ranges, not an ASCII hyphen", () => {
    // A manual test once sent "$50K - $150K" (ASCII hyphen) to Zapier. It would
    // have silently broken any exact-match Filter step, because src/schema.ts
    // ships "$50K \u2013 $150K". Pin the character explicitly.
    const ranges = BUDGETS.filter((budget) => budget.includes("\u2013"));
    expect(ranges.length).toBeGreaterThan(0);

    const used = FIXTURE_NAMES.map((name) => readFixture(name).estimatedBudget).filter(
      Boolean,
    );
    expect(used.length).toBeGreaterThan(0);

    for (const budget of used) {
      expect(budget).toContain("\u2013");
      expect(budget).not.toMatch(/\d+K -/); // ASCII hyphen between amounts
      expect(BUDGETS as readonly string[]).toContain(budget);
    }
  });
});
