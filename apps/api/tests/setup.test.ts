import { beforeEach, expect, it, vi } from "vitest";
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
      migrationsFolder: expect.stringMatching(/apps\/api\/drizzle\/$/),
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
