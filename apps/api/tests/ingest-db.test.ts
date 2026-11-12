import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { createDatabase } from "../src/db/client.js";
import { ads, brands } from "../src/db/schema.js";
import * as generation from "../src/ingest/ad.js";
import { runIngestTick } from "../src/ingest/tick.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_ingest_test";
const { db, close } = createDatabase(url.href);
const now = new Date("2027-01-01T00:00:00.123Z");

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_ingest_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(close);
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE ads, brands`);
  await db.insert(brands).values([
    { id: 1, name: "First" },
    { id: 2, name: "Second" },
  ]);
});

async function existing(id: string, overrides: Partial<typeof ads.$inferInsert> = {}) {
  await db.insert(ads).values({
    id,
    brandId: 1,
    headline: "Serum",
    bodyText: "Body",
    niche: "skincare",
    format: "image",
    status: "active",
    startDate: "2026-12-31",
    endDate: null,
    impressionRank: null,
    countries: ["US"],
    discoveredAt: now,
    ...overrides,
  });
}

function sequence(values: number[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("Injected random failure");
    return value;
  };
}
// Per insert: brand, niche, format, today decision, rank choice.
const known = [0, 0, 0, 0.3, 0.4];
const unknown = [0, 0, 0, 0.3, 0.399999];
function tick(values: number[], time = now) {
  return runIngestTick(db, { clock: () => time, random: sequence(values) });
}
async function state() {
  return db.select().from(ads).orderBy(ads.id);
}

it.each([
  [0, 1],
  [0.999999, 5],
])("inserts bounded counts (%s), even with no candidates", async (draw, count) => {
  await tick([draw, 0, ...Array.from({ length: count }, () => unknown).flat()]);
  const stored = await state();
  expect(stored).toHaveLength(count);
  expect(new Set(stored.map((ad) => ad.id)).size).toBe(count);
  for (const ad of stored) {
    expect(ad.id).toMatch(/^ingest-ad-[0-9a-f-]{36}$/);
    expect(ad).toMatchObject({
      brandId: 1,
      status: "active",
      endDate: null,
      startDate: "2027-01-01",
      discoveredAt: now,
      impressionRank: null,
    });
  }
});

it.each([
  [0, 1],
  [0.999999, 2],
])("randomly selects distinct pre-tick candidates (%s)", async (draw, count) => {
  for (const id of ["a", "b", "c"]) await existing(id, { impressionRank: id.charCodeAt(0) });
  await existing("future", { startDate: "2027-01-02" });
  await existing("inactive", { status: "inactive", endDate: "2026-12-31" });
  await tick([0, draw, ...Array(count).fill(0.999999), ...known]);
  const stored = await state();
  const deactivated = stored.filter((ad) => ["b", "c"].includes(ad.id) && ad.status === "inactive");
  expect(deactivated.map((ad) => ad.id)).toEqual(count === 1 ? ["c"] : ["b", "c"]);
  for (const ad of deactivated) {
    expect(ad.endDate).toBe("2027-01-01");
    expect(ad.impressionRank).toBe(ad.id.charCodeAt(0));
  }
  expect(stored.find((ad) => ad.id === "a")?.status).toBe("active");
  expect(stored.find((ad) => ad.id === "future")?.status).toBe("active");
  expect(stored.find((ad) => ad.id === "inactive")?.endDate).toBe("2026-12-31");
  expect(stored.filter((ad) => ad.id.startsWith("ingest-ad-")).every((ad) => ad.status === "active")).toBe(true);
});

it.each(["2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"])(
  "deactivates the sole available candidate using UTC today: %s",
  async (time) => {
    await existing("only", { impressionRank: 6 });
    await tick([0, 0.999999, 0, ...known], new Date(time));
    expect((await state()).find((ad) => ad.id === "only")).toMatchObject({
      status: "inactive",
      endDate: time.slice(0, 10),
      impressionRank: 6,
    });
  },
);

it("appends known ranks above active/inactive brand maxima, ignores nulls and allocates within a tick", async () => {
  await existing("one", { impressionRank: 4 });
  await existing("gap", {
    status: "inactive",
    endDate: "2026-12-31",
    impressionRank: 9,
  });
  await existing("other", { brandId: 2, impressionRank: 100 });
  await tick([0.999999, 0, 0, ...known, ...unknown, ...known, ...[0.999999, ...known.slice(1)], ...known]);
  const inserted = (await state()).filter((ad) => ad.id.startsWith("ingest-ad-"));
  expect(
    inserted
      .filter((ad) => ad.brandId === 1)
      .map((ad) => ad.impressionRank)
      .sort((a, b) => (a ?? 0) - (b ?? 0)),
  ).toEqual([null, 10, 11, 12]);
  expect(inserted.find((ad) => ad.brandId === 2)?.impressionRank).toBe(101);
});

it("starts a brand's first known rank at one", async () => {
  await tick([0, 0, ...known]);
  expect((await state())[0].impressionRank).toBe(1);
});

it("can allocate the final integer rank without wrapping", async () => {
  await existing("last", { impressionRank: 2_147_483_646 });
  await tick([0, 0, 0, ...known]);
  expect((await state()).find((ad) => ad.id.startsWith("ingest-ad-"))?.impressionRank).toBe(2_147_483_647);
});

it.each([2_147_483_647, 2_147_483_646])(
  "rolls back deactivation and all inserts on same-brand exhaustion from %s",
  async (rank) => {
    await existing("last", { impressionRank: rank });
    const before = await state();
    await expect(tick([0.25, 0, 0, ...known, ...known])).rejects.toThrow("Ingest rank space exhausted");
    expect(await state()).toEqual(before);
  },
);

it("allows null ranks even when known rank space is exhausted", async () => {
  await existing("last", { impressionRank: 2_147_483_647 });
  await tick([0, 0, 0, ...unknown]);
  expect((await state()).find((ad) => ad.id.startsWith("ingest-ad-"))?.impressionRank).toBeNull();
});

it("rolls back a completed deactivation and first insert on injected failure", async () => {
  await existing("candidate", { impressionRank: 3 });
  const before = await state();
  await expect(tick([0.25, 0, 0, ...known])).rejects.toThrow("Injected random failure");
  expect(await state()).toEqual(before);
});

it.each([null, "US", ["US", "ZZ"], [null]].map((countries) => ({ countries })))(
  "rejects invalid generated countries atomically: $countries",
  async ({ countries }) => {
    await existing("candidate", { impressionRank: 3 });
    const before = await state();
    const generate = generation.createIngestAd;
    vi.spyOn(generation, "createIngestAd")
      .mockImplementationOnce(generate)
      .mockImplementationOnce((input) => Object.assign(generate(input), { countries }));
    await expect(tick([0.25, 0, 0, ...known, ...known])).rejects.toThrow("Invalid ingest countries");
    expect(await state()).toEqual(before);
  },
);

it.each(["SIGINT", "SIGTERM"] as const)(
  "the CLI inserts/deactivates, exits cleanly on %s and releases connections",
  async (signal) => {
    await existing("process-candidate", { startDate: "2020-01-01" });
    const processUrl = new URL(url);
    processUrl.searchParams.set("application_name", "ingest-process-smoke");
    const child = spawn(process.execPath, ["--import", "tsx", "src/ingest/cli.ts"], {
      env: { ...process.env, DATABASE_URL: processUrl.href },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    try {
      await expect
        .poll(
          async () => {
            const stored = await state();
            return (
              stored.some((ad) => ad.id.startsWith("ingest-ad-")) &&
              stored.find((ad) => ad.id === "process-candidate")?.status === "inactive"
            );
          },
          { timeout: 8000, interval: 100 },
        )
        .toBe(true);
      child.kill(signal);
      expect(await Promise.race([exited, delay(5000).then(() => "timeout")])).toEqual([0, null]);
      const connections = await db.execute(
        sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'ingest-process-smoke'`,
      );
      expect(connections.rows).toEqual([{ count: 0 }]);
      expect(output).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
  15000,
);

function terminateProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

it.each([
  ["unavailable database", "postgresql://credential-sentinel:private@127.0.0.1:1/unavailable"],
  ["invalid configuration", "credential-sentinel:invalid"],
])(
  "root ingest forwards to the CLI and sanitizes %s failure",
  async (_label, databaseUrl) => {
    const child = spawn("npm", ["run", "ingest", "--silent"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const exited = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    try {
      expect(await Promise.race([exited, delay(8000).then(() => "timeout")])).toEqual([1, null]);
      expect(output).toBe("Ingest failed.\n");
    } finally {
      terminateProcessGroup(child.pid);
      await exited;
    }
  },
  10000,
);

it("fails atomically when no existing brands are available", async () => {
  await db.delete(brands);
  await expect(tick([0, 0])).rejects.toThrow("Ingest requires existing brands");
  expect(await state()).toEqual([]);
});
