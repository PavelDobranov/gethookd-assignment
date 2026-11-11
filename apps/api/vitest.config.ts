import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/login.test.ts",
            "tests/postgres.test.ts",
            "tests/db.test.ts",
            "tests/seed.test.ts",
          ],
        },
      },
      {
        test: {
          name: "postgres",
          include: [
            "tests/login.test.ts",
            "tests/postgres.test.ts",
            "tests/db.test.ts",
            "tests/seed.test.ts",
          ],
          globalSetup: ["tests/postgres-setup.ts"],
        },
      },
    ],
  },
});
