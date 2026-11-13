// Tests only: the default prefix labels synthetic rows; it is not derived from
// a hash. Callers using a known public credential can supply its literal prefix.
export function apiKeyFixture(userId: string, keyHash: string, prefix = "test-fixture") {
  return { userId, keyHash, prefix, scopes: ["search:read", "keys:manage"] };
}
