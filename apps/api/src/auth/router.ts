import { json, type Request, type RequestHandler, type Response, Router } from "express";

import type { Database } from "../db/client.js";
import { errorBody } from "../shared/errors.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";
import { type AuthenticatedLocals, createRequireAuthentication } from "./middleware.js";
import { createAuthService } from "./service.js";
import { parseCredentials } from "./validation.js";

type AuthRouterDependencies = {
  db: Database;
  jwtSecret: string;
};

function createLoginHandler(auth: Pick<ReturnType<typeof createAuthService>, "login">): RequestHandler {
  return async function handleLogin(req, res) {
    const credentials = parseCredentials(req.body);

    if (!credentials) {
      res
        .status(422)
        .json(
          errorBody(
            "VALIDATION_ERROR",
            "Username and password must be nonempty strings of at most 100 and 1024 characters.",
          ),
        );
      return;
    }

    const session = await auth.login(credentials);

    if (!session) {
      res.status(401).json(errorBody("INVALID_CREDENTIALS", "Invalid username or password."));
      return;
    }

    res.json(session);
  };
}

function handleGetMe(_req: Request, res: Response<unknown, AuthenticatedLocals>) {
  res.json({ user: res.locals.user });
}

export function createAuthRouter({ db, jwtSecret }: AuthRouterDependencies) {
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
