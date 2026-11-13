import { readFileSync } from "node:fs";
import { parse } from "dotenv";

type Environment = Record<string, string | undefined>;

type ConfigOptions = {
  env?: Environment;
  envFile?: string | URL | null;
  context?: "host" | "container";
};

// Public local-development placeholder, never a production signing secret.
const developmentJwtSecret = "gethookd-public-development-secret-do-not-use-in-production";

// Public local-development placeholder, independent of portal and API credentials.
export const developmentCursorSecret = "gethookd-public-development-cursor-secret-do-not-use-in-production";

export function loadConfig({
  env = process.env,
  envFile = new URL("../../../.env", import.meta.url),
  context = "host",
}: ConfigOptions = {}) {
  const values: Environment = {};
  if (envFile !== null) {
    try {
      Object.assign(values, parse(readFileSync(envFile)));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Unable to read root .env");
      }
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) values[key] = value;
  }

  function setting(key: string, fallback: string) {
    const value = values[key] ?? fallback;
    if (!value.trim() || /\p{Cc}/u.test(value)) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  }

  const postgresUser = setting("POSTGRES_USER", "gethookd");
  const postgresPassword = setting("POSTGRES_PASSWORD", "gethookd");
  const postgresDb = setting("POSTGRES_DB", "gethookd");
  const jwtSecret = setting("JWT_SECRET", developmentJwtSecret);
  if (Buffer.byteLength(jwtSecret, "utf8") < 32) {
    throw new Error("Invalid JWT_SECRET");
  }

  const cursorSecret = setting("CURSOR_SECRET", developmentCursorSecret);
  if (Buffer.byteLength(cursorSecret, "utf8") < 32) {
    throw new Error("Invalid CURSOR_SECRET");
  }

  function encode(key: string, value: string) {
    try {
      return encodeURIComponent(value);
    } catch {
      throw new Error(`Invalid ${key}`);
    }
  }

  const host = context === "container" ? "db" : "localhost";
  const derivedUrl = `postgresql://${encode("POSTGRES_USER", postgresUser)}:${encode("POSTGRES_PASSWORD", postgresPassword)}@${host}:5432/${encode("POSTGRES_DB", postgresDb)}`;
  const databaseUrl = setting("DATABASE_URL", derivedUrl);
  try {
    const url = new URL(databaseUrl);
    decodeURI(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length <= 1 ||
      url.hash ||
      /\s/.test(databaseUrl)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }

  return { postgresUser, postgresPassword, postgresDb, databaseUrl, jwtSecret, cursorSecret };
}
