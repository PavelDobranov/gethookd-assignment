import { hashPassword } from "../auth/password.js";
import type { createDatabase } from "./client.js";
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
