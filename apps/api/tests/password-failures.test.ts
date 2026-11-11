import { scrypt } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/auth/password.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, scrypt: vi.fn(crypto.scrypt) };
});

afterEach(() => vi.mocked(scrypt).mockReset());

const storedHash = `scrypt$131072$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

it("propagates unexpected asynchronous scrypt failures", async () => {
  const failure = new Error("Cryptographic operation failed");
  vi.mocked(scrypt).mockImplementationOnce(
    (_password, _salt, _length, _options, callback) => {
      callback(failure, Buffer.alloc(0));
    },
  );
  await expect(verifyPassword("password", storedHash)).rejects.toBe(failure);
});

it("propagates unexpected synchronous scrypt failures", async () => {
  const failure = new Error("Cryptographic setup failed");
  vi.mocked(scrypt).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(verifyPassword("password", storedHash)).rejects.toBe(failure);
});

it("rejects invalid inputs before invoking scrypt", async () => {
  expect(await verifyPassword("", storedHash)).toBe(false);
  expect(await verifyPassword("password", "malformed-hash")).toBe(false);
  expect(scrypt).not.toHaveBeenCalled();
});
