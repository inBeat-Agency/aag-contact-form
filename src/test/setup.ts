import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Unmount any React trees rendered during a test so DOM state never leaks
// between test cases. Runs after every test across all suites.
afterEach(() => {
  cleanup();
});
