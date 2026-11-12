import { eq } from "drizzle-orm";

import type { createDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import { signToken, verifySubject } from "./jwt.js";
import { verifyPassword } from "./password.js";

type Database = ReturnType<typeof createDatabase>["db"];

export type Credentials = {
  username: string;
  password: string;
};

export function createAuthService(db: Database, jwtSecret: string) {
  return {
    async login({ username, password }: Credentials) {
      const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return null;
      }

      return {
        token: await signToken(String(user.id), jwtSecret),
        user: {
          id: String(user.id),
          username: user.username,
        },
      };
    },

    async getUser(token: string) {
      const subject = await verifySubject(token, jwtSecret);
      if (!subject) {
        return null;
      }

      const [user] = await db
        .select({
          id: users.id,
          username: users.username,
        })
        .from(users)
        .where(eq(users.id, subject))
        .limit(1);

      return user ? { id: String(user.id), username: user.username } : null;
    },
  };
}
