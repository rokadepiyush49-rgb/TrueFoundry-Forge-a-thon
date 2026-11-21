import { defineConfig } from "vitest/config";
// End-to-end tests need a TrueForge server: see test/e2e/README.md
export default defineConfig({
  test: { include: ["test/e2e/**/*.e2e.ts"], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false, sequence: { concurrent: false } },
});
