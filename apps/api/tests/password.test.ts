import { scryptSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

const password = "demo-password";
let storedHash: string;
beforeAll(async () => {
  storedHash = await hashPassword(password);
});

describe("password hashing", () => {
  it("records parameters and random salts, never plaintext", async () => {
    const secondHash = await hashPassword(password);
    expect(storedHash).toMatch(/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(secondHash).not.toBe(storedHash);
    expect(secondHash.split("$")[4]).not.toBe(storedHash.split("$")[4]);
    expect(storedHash).not.toContain(password);
    expect(await verifyPassword(password, storedHash)).toBe(true);
    expect(await verifyPassword(password, secondHash)).toBe(true);
  });

  it("matches independent native scrypt output using the recorded salt and parameters", () => {
    const [, n, r, p, salt, key] = storedHash.split("$");
    const derived = scryptSync(password, Buffer.from(salt, "hex"), 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    expect(derived.toString("hex")).toBe(key);
  });

  it("rejects wrong passwords, including case changes and added whitespace", async () => {
    for (const wrong of ["wrong-password", "Demo-password", ` ${password}`, `${password} `]) {
      expect(await verifyPassword(wrong, storedHash)).toBe(false);
    }
  });

  it("preserves Unicode and whitespace exactly", async () => {
    const exact = "  p🔑ässword  ";
    const hash = await hashPassword(exact);
    expect(await verifyPassword(exact, hash)).toBe(true);
    expect(await verifyPassword(exact.trim(), hash)).toBe(false);
  });

  it("accepts the maximum password length", async () => {
    const longest = "x".repeat(1024);
    expect(await verifyPassword(longest, await hashPassword(longest))).toBe(true);
  });

  it.each(["", "x".repeat(1025), null, undefined, 42, {}])(
    "rejects invalid password input %# without exposing it",
    async (input) => {
      await expect(Reflect.apply(hashPassword, undefined, [input])).rejects.toThrow(
        "Password must be a nonempty string of at most 1024 characters",
      );
      expect(await Reflect.apply(verifyPassword, undefined, [input, storedHash])).toBe(false);
    },
  );

  it.each([null, undefined, 42, {}, "", "x".repeat(10000)])(
    "safely rejects invalid stored hash input %#",
    async (input) => {
      expect(await Reflect.apply(verifyPassword, undefined, [password, input])).toBe(false);
    },
  );

  it("rejects damaged or unsupported formats and cost parameters", async () => {
    const parts = storedHash.split("$");
    const malformed = [`${storedHash}$extra`, storedHash.slice(0, -1), ` ${storedHash}`, `${storedHash}\n`];
    for (const [index, value] of [
      [0, "argon2"],
      [1, "1073741824"],
      [1, "0"],
      [1, "-1"],
      [1, "131072.0"],
      [2, "0"],
      [2, "16"],
      [3, "0"],
      [3, "2"],
      [4, "aa"],
      [4, "z".repeat(32)],
      [5, "aa"],
      [5, "g".repeat(128)],
    ] as const) {
      const changed = [...parts];
      changed[index] = value;
      malformed.push(changed.join("$"));
    }
    for (const hash of malformed) {
      expect(await verifyPassword(password, hash)).toBe(false);
    }
  });

  it("rejects tampered salts and same-length derived keys", async () => {
    for (const index of [4, 5]) {
      const parts = storedHash.split("$");
      parts[index] = (parts[index][0] === "0" ? "1" : "0") + parts[index].slice(1);
      expect(await verifyPassword(password, parts.join("$"))).toBe(false);
    }
  });
});
