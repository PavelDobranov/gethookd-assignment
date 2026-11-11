import { json, Router } from "express";
import { handleAuthError } from "./auth.errors.js";
import { type AuthOptions, createAuthService } from "./auth.service.js";
import { parseBearerToken, parseCredentials } from "./auth.validation.js";

export type { AuthOptions } from "./auth.service.js";

export function createAuthRouter(options: AuthOptions) {
  const auth = createAuthService(options);
  const router = Router();
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
    const token = parseBearerToken(req.get("authorization"));
    const user = await auth.getUser(token);
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
