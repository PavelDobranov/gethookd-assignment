import { json, Router } from "express";
import type { createDatabase } from "../db/client.js";
import { handleAuthError } from "./auth.errors.js";
import { createAuthService } from "./auth.service.js";
import { parseCredentials } from "./auth.validation.js";

export type AuthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
};

export function createAuthRouter({ db, jwtSecret }: AuthOptions) {
  const router = Router();
  const auth = createAuthService(db, jwtSecret);

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Parse primitive JSON too so valid JSON with invalid field shape is a 422.
  router.use(json({ limit: "16kb", strict: false, inflate: false }));

  router.post("/login", async (req, res) => {
    const credentials = parseCredentials(req.body);

    if (!credentials) {
      res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Username and password must be nonempty strings of at most 100 and 1024 characters.",
        },
      });
      return;
    }
    const session = await auth.login(credentials);

    if (!session) {
      res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid username or password.",
        },
      });
      return;
    }
    res.json(session);
  });

  router.get("/me", async (req, res) => {
    const token = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    const user = token ? await auth.getUser(token) : null;

    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Authentication required." },
      });
      return;
    }
    res.json({ user });
  });

  router.use(handleAuthError);
  return router;
}
