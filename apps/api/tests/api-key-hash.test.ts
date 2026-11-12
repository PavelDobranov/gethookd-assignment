import { expect, it } from "vitest";
import { hashApiKey } from "../src/api-keys/keys.js";

it("hashes the public development fixture as SHA-256 lowercase hexadecimal", () => {
  expect(hashApiKey("gethookd-public-demo-api-key-m2")).toBe(
    "58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47",
  );
});

it("hashes the exact key without trimming or changing case", () => {
  expect(hashApiKey("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(hashApiKey("ABC")).not.toBe(hashApiKey("abc"));
  expect(hashApiKey(" abc ")).not.toBe(hashApiKey("abc"));
});
