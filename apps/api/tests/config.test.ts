import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function envFile(contents: string) {
  const directory = mkdtempSync(join(tmpdir(), "gethookd-config-"));
  directories.push(directory);
  const path = join(directory, ".env");
  writeFileSync(path, contents);
  return path;
}

describe("server configuration", () => {
  it("provides public host defaults without an env file", () => {
    const config = loadConfig({ env: {}, envFile: null });
    expect(config.postgresUser).toBe("gethookd");
    expect(config.postgresPassword).toBe("gethookd");
    expect(config.postgresDb).toBe("gethookd");
    expect(config.databaseUrl).toBe("postgresql://gethookd:gethookd@localhost:5432/gethookd");
    expect(Buffer.byteLength(config.jwtSecret)).toBeGreaterThanOrEqual(32);
  });

  it("derives container URLs and safely encodes credentials and database names", () => {
    const config = loadConfig({
      envFile: null,
      context: "container",
      env: {
        POSTGRES_USER: "u@:/",
        POSTGRES_PASSWORD: "p?#% /",
        POSTGRES_DB: "db/#?",
      },
    });
    expect(config.databaseUrl).toBe("postgresql://u%40%3A%2F:p%3F%23%25%20%2F@db:5432/db%2F%23%3F");
  });

  it.each(["host", "container"] as const)("preserves an explicit URL in %s context", (context) => {
    const databaseUrl = "postgres://custom:password@localhost:9876/other?sslmode=require";
    expect(
      loadConfig({
        envFile: null,
        context,
        env: { DATABASE_URL: databaseUrl },
      }).databaseUrl,
    ).toBe(databaseUrl);
  });

  it("loads dotenv values without mutating process.env; exports win", () => {
    const path = envFile(
      'POSTGRES_USER=file-user\nPOSTGRES_PASSWORD="file#password"\nPOSTGRES_DB=file-db\nJWT_SECRET=file-secret-at-least-32-bytes-long\n',
    );
    const before = { ...process.env };
    const config = loadConfig({
      envFile: path,
      env: { POSTGRES_USER: "exported", POSTGRES_DB: undefined },
    });
    expect(config.postgresUser).toBe("exported");
    expect(config.postgresPassword).toBe("file#password");
    expect(config.postgresDb).toBe("file-db");
    expect(config.jwtSecret).toBe("file-secret-at-least-32-bytes-long");
    expect(process.env).toEqual(before);
  });

  it("honors an explicit URL from dotenv over derived credentials", () => {
    const path = envFile("DATABASE_URL=postgresql://file:password@remote:5432/file-db\n");
    expect(loadConfig({ envFile: path, env: { POSTGRES_USER: "exported" } }).databaseUrl).toBe(
      "postgresql://file:password@remote:5432/file-db",
    );
    expect(
      loadConfig({
        envFile: path,
        env: { DATABASE_URL: "postgres://export:password@remote/db" },
      }).databaseUrl,
    ).toBe("postgres://export:password@remote/db");
  });

  it("tolerates a missing optional env file, but not an unreadable one", () => {
    const path = envFile("");
    expect(loadConfig({ env: {}, envFile: `${path}.absent` }).postgresDb).toBe("gethookd");
    expect(() => loadConfig({ env: {}, envFile: join(path, "child") })).toThrow("Unable to read root .env");
  });

  it.each(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_URL", "JWT_SECRET"])(
    "rejects explicitly empty %s, including exported overrides",
    (key) => {
      const path = envFile(`${key}=valid-file-value\n`);
      expect(() => loadConfig({ envFile: path, env: { [key]: "" } })).toThrow(`Invalid ${key}`);
    },
  );

  it.each([
    ["POSTGRES_USER", " \t"],
    ["POSTGRES_DB", "bad\nname"],
    ["POSTGRES_PASSWORD", "bad\0password"],
    ["JWT_SECRET", "short-private-secret"],
    ["DATABASE_URL", "https://private:password@remote/db"],
    ["DATABASE_URL", "postgres://private:password@/db"],
    ["DATABASE_URL", "postgres://remote"],
    ["DATABASE_URL", "postgres://remote:invalid/db"],
    ["DATABASE_URL", "postgres://remote/db%ZZ"],
    ["DATABASE_URL", " postgres://remote/db"],
  ])("rejects malformed %s without disclosing its value", (key, value) => {
    expect(() => loadConfig({ envFile: null, env: { [key]: value } })).toThrow(new Error(`Invalid ${key}`));
  });
});
