import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";

import { hashApiKey } from "../api-keys/index.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";
import { generateFixtures } from "./fixtures.js";
import { apiKeys, users } from "./schema.js";
import { seedWorld } from "./seed-world.js";

type Database = ReturnType<typeof createDatabase>["db"];

export async function seedDemoUser(db: Pick<Database, "insert">) {
  // Public local-development fixture; never replace existing credentials.
  const passwordHash = await hashPassword("demo-password");

  await db.insert(users).values({ username: "demo", passwordHash }).onConflictDoNothing({ target: users.username });
}

export async function seedDatabase(db: Database) {
  const fixtures = generateFixtures();

  await db.transaction(async (tx) => {
    await seedDemoUser(tx);

    const [demo] = await tx.select({ id: users.id }).from(users).where(eq(users.username, "demo"));

    await seedWorld(tx, fixtures);

    const keyHash = hashApiKey("gethookd-public-demo-api-key-m2");
    const [existingKey] = await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyHash, keyHash));

    if (!existingKey) {
      await tx.insert(apiKeys).values({ userId: demo.id, keyHash });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { db, close } = createDatabase(loadConfig().databaseUrl);

    try {
      await seedDatabase(db);
    } finally {
      await close();
    }

    console.info("Database seed completed.");
  } catch {
    // Do not print connection URLs, SQL parameters or password hashes.
    console.error("Database seeding failed. Check database configuration and apply committed migrations first.");
    process.exitCode = 1;
  }
}
