import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP scrypt baseline: N=2^17, r=8, p=1 (~128 MiB per derivation).
const cost = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const saltBytes = 16;
const keyBytes = 64;
const format = `scrypt$${cost.N}$${cost.r}$${cost.p}`;

function validPassword(password: string) {
  return typeof password === "string" && password.length > 0 && password.length <= 1024;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, cost, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) {
    throw new TypeError("Password must be a nonempty string of at most 1024 characters");
  }

  const salt = randomBytes(saltBytes);
  const key = await deriveKey(password, salt);

  return `${format}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!validPassword(password) || typeof storedHash !== "string" || storedHash.length > 256) {
    return false;
  }

  // Accept only this version's cost profile; never run attacker-selected costs.
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts.slice(0, 4).join("$") !== format) {
    return false;
  }

  const [, , , , salt, key] = parts;
  if (salt.length !== saltBytes * 2 || key.length !== keyBytes * 2 || /[^a-f0-9]/.test(salt) || /[^a-f0-9]/.test(key)) {
    return false;
  }

  const derived = await deriveKey(password, Buffer.from(salt, "hex"));

  return timingSafeEqual(derived, Buffer.from(key, "hex"));
}
