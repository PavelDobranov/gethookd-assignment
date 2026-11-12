import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";
import { seedDatabase } from "./seed.js";

export async function initializeDatabase(databaseUrl: string) {
  const { db, close } = createDatabase(databaseUrl);
  let stage = "migration";
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
    });
    stage = "seed";
    await seedDatabase(db);
  } catch {
    throw new Error(`Database initialization failed during ${stage}.`);
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await initializeDatabase(loadConfig().databaseUrl);
    console.info("Database initialization completed.");
  } catch {
    console.error("Database initialization failed. Check configuration, database readiness and committed migrations.");
    process.exitCode = 1;
  }
}
