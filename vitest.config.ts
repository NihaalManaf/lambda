import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  // store.ts writes under LAMBDA_DATA_DIR at import: keep tests out of the real app data
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    env: { LAMBDA_DATA_DIR: path.join(os.tmpdir(), "lambda-vitest") },
  },
});
