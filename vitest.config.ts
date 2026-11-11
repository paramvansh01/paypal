import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: false,
    // Many test files launch real browsers (Chromium + WebKit); too many at once and WebKit crashes.
    maxWorkers: 6,
  },
});
