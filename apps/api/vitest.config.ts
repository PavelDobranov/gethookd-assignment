import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/v0.test.ts",
            "tests/api-keys.test.ts",
            "tests/health.test.ts",
            "tests/identity.test.ts",
            "tests/login.test.ts",
            "tests/postgres.test.ts",
            "tests/db.test.ts",
            "tests/seed.test.ts",
            "tests/world-model.test.ts",
            "tests/world-seed.test.ts",
          ],
        },
      },
      {
        test: {
          name: "postgres",
          // Real scrypt/seed suites share the test server; keep deadlines isolated.
          fileParallelism: false,
          include: [
            "tests/v0.test.ts",
            "tests/api-keys.test.ts",
            "tests/health.test.ts",
            "tests/identity.test.ts",
            "tests/login.test.ts",
            "tests/postgres.test.ts",
            "tests/db.test.ts",
            "tests/seed.test.ts",
            "tests/world-model.test.ts",
            "tests/world-seed.test.ts",
          ],
          globalSetup: ["tests/postgres-setup.ts"],
        },
      },
    ],
  },
});
