import { eq } from "drizzle-orm";
import type { createDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Credentials } from "./auth.validation.js";
import { signToken, verifySubject } from "./jwt.js";
import { verifyPassword } from "./password.js";

export type AuthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
};

export function createAuthService({ db, jwtSecret }: AuthOptions) {
  return {
    async login({ username, password }: Credentials) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return null;
      }
      const token = await signToken(String(user.id), jwtSecret);
      return { token, user: { id: String(user.id), username: user.username } };
    },

    async getUser(token: string | null) {
      if (!token) return null;
      const subject = await verifySubject(token, jwtSecret);
      if (!subject) return null;

      const [user] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, subject))
        .limit(1);
      if (!user) return null;
      return { id: String(user.id), username: user.username };
    },
  };
}
