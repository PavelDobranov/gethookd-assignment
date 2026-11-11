import { json, type Response, Router } from "express";
import type { createDatabase } from "../db/client.js";
import { handleAuthError } from "./errors.js";
import {
  type AuthenticatedLocals,
  createRequireAuthentication,
} from "./middleware.js";
import { createAuthService } from "./service.js";
import { parseCredentials } from "./validation.js";

export type AuthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
};

export function createAuthRouter({ db, jwtSecret }: AuthOptions) {
  const router = Router();
  const auth = createAuthService(db, jwtSecret);
  const requireAuthentication = createRequireAuthentication(auth);

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

  router.get(
    "/me",
    requireAuthentication,
    (_req, res: Response<unknown, AuthenticatedLocals>) => {
      res.json({ user: res.locals.user });
    },
  );

  router.use(handleAuthError);

  return router;
}
