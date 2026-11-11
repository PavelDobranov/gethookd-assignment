import { eq } from "drizzle-orm";
import { type ErrorRequestHandler, json, Router } from "express";
import type { createDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import { signToken, verifySubject } from "./jwt.js";
import { verifyPassword } from "./password.js";

export type AuthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
};

type Credentials = { username: string; password: string };

function validCredentials(body: unknown): body is Credentials {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (
    "username" in body &&
    typeof body.username === "string" &&
    body.username.length > 0 &&
    body.username.length <= 100 &&
    "password" in body &&
    typeof body.password === "string" &&
    body.password.length > 0 &&
    body.password.length <= 1024
  );
}

function databaseUnavailable(error: unknown): boolean {
  // Drizzle wraps driver errors in cause; never return their messages or SQL.
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    if ("code" in error && typeof error.code === "string") {
      if (
        /^(08|53|57P0)/.test(error.code) ||
        [
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "ENOTFOUND",
          "EAI_AGAIN",
        ].includes(error.code)
      )
        return true;
    }
    if (
      [
        "Connection terminated unexpectedly",
        "Connection terminated due to connection timeout",
        "timeout exceeded when trying to connect",
      ].includes(error.message)
    )
      return true;
    error = error.cause;
  }
  return false;
}

export function createAuthRouter({ db, jwtSecret }: AuthOptions) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Parse primitive JSON too so valid JSON with invalid field shape is a 422.
  router.use(json({ limit: "16kb", strict: false, inflate: false }));
  router.post("/login", async (req, res) => {
    const body: unknown = req.body;
    if (!validCredentials(body)) {
      res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Username and password must be nonempty strings of at most 100 and 1024 characters.",
        },
      });
      return;
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username))
      .limit(1);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid username or password.",
        },
      });
      return;
    }
    const token = await signToken(String(user.id), jwtSecret);
    res.json({ token, user: { id: String(user.id), username: user.username } });
  });
  router.get("/me", async (req, res) => {
    const bearer =
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        req.get("authorization") ?? "",
      );
    const subject = bearer ? await verifySubject(bearer[1], jwtSecret) : null;
    const [user] = subject
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(eq(users.id, subject))
          .limit(1)
      : [];
    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Authentication required." },
      });
      return;
    }
    res.json({ user: { id: String(user.id), username: user.username } });
  });
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (
      error instanceof Error &&
      "type" in error &&
      [
        "entity.parse.failed",
        "entity.too.large",
        "encoding.unsupported",
        "charset.unsupported",
        "request.aborted",
        "request.size.invalid",
      ].includes(String(error.type))
    ) {
      res.status(400).json({
        error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
      });
    } else if (databaseUnavailable(error)) {
      res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication service unavailable.",
        },
      });
    } else {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Internal server error." },
      });
    }
  };
  router.use(handleError);
  return router;
}
