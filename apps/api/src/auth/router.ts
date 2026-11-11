import {
  json,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";

import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";
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

function createLoginHandler(
  auth: Pick<ReturnType<typeof createAuthService>, "login">,
): RequestHandler {
  return async function handleLogin(req, res) {
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
  };
}

function handleGetMe(
  _req: Request,
  res: Response<unknown, AuthenticatedLocals>,
) {
  res.json({ user: res.locals.user });
}

export function createAuthRouter({ db, jwtSecret }: AuthOptions) {
  const router = Router();
  const auth = createAuthService(db, jwtSecret);
  const requireAuthentication = createRequireAuthentication(auth);
  const handleLogin = createLoginHandler(auth);

  router.use(disableCaching);
  // Parse primitive JSON too so valid JSON with invalid field shape is a 422.
  router.use(json({ limit: "16kb", strict: false, inflate: false }));

  router.post("/login", handleLogin);
  router.get("/me", requireAuthentication, handleGetMe);

  return router;
}
