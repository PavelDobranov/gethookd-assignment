import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";
import { runCommand, runSetup } from "../../../scripts/setup.mjs";
import { initializeDatabase } from "../src/db/initialize.js";

const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
  seed: vi.fn(),
  close: vi.fn(),
}));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: mocks.migrate,
}));
vi.mock("../src/db/seed.js", () => ({ seedDemoUser: mocks.seed }));
vi.mock("../src/db/client.js", () => ({
  createDatabase: () => ({ db: {}, close: mocks.close }),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

it("keeps dev free of setup and exposes explicit workspace-local database commands", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  expect(scripts.dev).toBe(
    'concurrently --kill-others-on-fail -n api,web "npm run dev -w @gethookd/api" "npm run dev -w @gethookd/web"',
  );
  expect(scripts.setup).toBe("node scripts/setup.mjs");
  for (const command of ["generate", "migrate", "seed", "studio"]) {
    expect(scripts[`db:${command}`]).toBe(
      `npm run db:${command} -w @gethookd/api`,
    );
  }
  const api = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(api.scripts["db:studio"]).toBe(
    "drizzle-kit studio --config=drizzle.config.ts --host=127.0.0.1",
  );
});

it("waits for only the db service before running the shared initializer", async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  await runSetup(run);
  expect(run.mock.calls[0]).toEqual([
    "docker",
    [
      "compose",
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "30",
      "--no-deps",
      "db",
    ],
    120000,
  ]);
  expect(run.mock.calls[1]).toEqual([
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/db/initialize.ts", import.meta.url)),
    ],
    60000,
  ]);
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not initialize after readiness failure and sanitizes diagnostics", async () => {
  const run = vi
    .fn()
    .mockRejectedValue(new Error("private connection details"));
  await expect(runSetup(run)).rejects.toThrow(
    "Setup failed during database readiness.",
  );
  expect(run).toHaveBeenCalledOnce();
});

it("propagates initialization failure without starting any further process", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("private hash"));
  await expect(runSetup(run)).rejects.toThrow(
    "Setup failed during database initialization.",
  );
  expect(run).toHaveBeenCalledTimes(2);
});

it("bounds subprocess execution and rejects nonzero exits", async () => {
  await expect(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 50),
  ).rejects.toThrow("Command failed or timed out.");
  await expect(
    runCommand(process.execPath, ["-e", "process.exit(2)"], 2000),
  ).rejects.toThrow("Command failed or timed out.");
});

it("initializes in migration, seed, close order", async () => {
  const stages: string[] = [];
  mocks.migrate.mockImplementation(async () => {
    stages.push("migrate");
  });
  mocks.seed.mockImplementation(async () => {
    stages.push("seed");
  });
  mocks.close.mockImplementation(async () => {
    stages.push("close");
  });
  await initializeDatabase("postgresql://test:test@localhost/test");
  expect(stages).toEqual(["migrate", "seed", "close"]);
  expect(mocks.migrate).toHaveBeenCalledWith(
    {},
    {
      migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
    },
  );
});

it("stops before seed and closes the pool when migrations fail", async () => {
  mocks.migrate.mockRejectedValue(
    new Error("private SQL and connection details"),
  );
  await expect(initializeDatabase("test-url")).rejects.toThrow(
    "Database initialization failed during migration.",
  );
  expect(mocks.seed).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("propagates seed failure safely and closes the pool", async () => {
  mocks.seed.mockRejectedValue(new Error("private password hash"));
  await expect(initializeDatabase("test-url")).rejects.toThrow(
    "Database initialization failed during seed.",
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});
