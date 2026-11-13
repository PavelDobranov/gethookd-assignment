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

  it("provides the same independent public cursor default in both startup contexts", () => {
    for (const context of ["host", "container"] as const) {
      const config = loadConfig({ env: {}, envFile: null, context });
      expect(config.cursorSecret).toBe("gethookd-public-development-cursor-secret-do-not-use-in-production");
      expect(config.cursorSecret).not.toBe(config.jwtSecret);
      expect(
        loadConfig({
          env: { JWT_SECRET: "independent-jwt-secret-at-least-32-bytes" },
          envFile: null,
          context,
        }).cursorSecret,
      ).toBe(config.cursorSecret);
    }
  });

  it.each(["host", "container"] as const)(
    "loads a stable cursor override with exported-env precedence in %s context",
    (context) => {
      const fileSecret = "file-cursor-secret-at-least-32-bytes";
      const exportedSecret = "exported-cursor-secret-at-least-32-bytes";
      const path = envFile(`CURSOR_SECRET=${fileSecret}\n`);
      const defaultJwt = loadConfig({ env: {}, envFile: null }).jwtSecret;
      expect(loadConfig({ env: {}, envFile: path, context }).cursorSecret).toBe(fileSecret);
      const before = { ...process.env };
      const config = loadConfig({
        env: { CURSOR_SECRET: exportedSecret },
        envFile: path,
        context,
      });
      expect(config.cursorSecret).toBe(exportedSecret);
      expect(config.jwtSecret).toBe(defaultJwt);
      expect(loadConfig({ env: { CURSOR_SECRET: exportedSecret }, envFile: null }).cursorSecret).toBe(
        config.cursorSecret,
      );
      expect(process.env).toEqual(before);
    },
  );

  it("measures cursor secrets in UTF-8 bytes without trimming valid values", () => {
    const cursorSecret = ` ${"é".repeat(15)} `;
    expect(Buffer.byteLength(cursorSecret, "utf8")).toBe(32);
    expect(loadConfig({ env: { CURSOR_SECRET: cursorSecret }, envFile: null }).cursorSecret).toBe(cursorSecret);
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

  it.each(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_URL", "JWT_SECRET", "CURSOR_SECRET"])(
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
    ["CURSOR_SECRET", ""],
    ["CURSOR_SECRET", " ".repeat(32)],
    ["CURSOR_SECRET", "a".repeat(31)],
    ["CURSOR_SECRET", "é".repeat(15)],
    ["CURSOR_SECRET", `${"a".repeat(32)}\n`],
    ["CURSOR_SECRET", `${"a".repeat(32)}\0`],
    ["CURSOR_SECRET", `${"a".repeat(32)}\u007f`],
    ["CURSOR_SECRET", `${"a".repeat(32)}\u0085`],
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
