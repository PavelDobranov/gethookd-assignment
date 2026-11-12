import { pathToFileURL } from "node:url";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";
import { users } from "./schema.js";

export async function seedDemoUser(
  db: ReturnType<typeof createDatabase>["db"],
) {
  // Public local-development fixture; never replace existing credentials.
  const passwordHash = await hashPassword("demo-password");
  await db
    .insert(users)
    .values({ username: "demo", passwordHash })
    .onConflictDoNothing({ target: users.username });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { db, close } = createDatabase(loadConfig().databaseUrl);
    try {
      await seedDemoUser(db);
    } finally {
      await close();
    }
    console.info("Demo user seed completed.");
  } catch {
    // Do not print connection URLs, SQL parameters or password hashes.
    console.error(
      "Database seeding failed. Check database configuration and apply committed migrations first.",
    );
    process.exitCode = 1;
  }
}
