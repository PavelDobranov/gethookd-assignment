import { describe, expect, it } from "vitest";

import { loadMcpConfig } from "../src/config.js";

describe("loadMcpConfig", () => {
  it("binds to loopback with REST on :3000 and MCP on :3001 by default", () => {
    expect(loadMcpConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3001,
      apiBaseUrl: "http://127.0.0.1:3000",
    });
  });

  it("reads overrides from the environment", () => {
    expect(
      loadMcpConfig({
        MCP_HOST: "0.0.0.0",
        MCP_PORT: "4010",
        API_BASE_URL: "https://api.internal:8443",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 4010,
      apiBaseUrl: "https://api.internal:8443",
    });
  });

  it("trims surrounding whitespace and treats blank values as unset", () => {
    expect(
      loadMcpConfig({
        MCP_HOST: "  10.0.0.5  ",
        MCP_PORT: "   ",
        API_BASE_URL: "  http://127.0.0.1:3000  ",
      }),
    ).toEqual({
      host: "10.0.0.5",
      port: 3001,
      apiBaseUrl: "http://127.0.0.1:3000",
    });
  });

  it.each(["0", "65536", "-1", "3.5", "abc", "12 34"])(
    "fails actionably on an out-of-range or non-integer MCP_PORT: %s",
    (value) => {
      expect(() => loadMcpConfig({ MCP_PORT: value })).toThrow(`Invalid MCP_PORT: ${value}`);
    },
  );

  it("accepts the port range boundaries", () => {
    expect(loadMcpConfig({ MCP_PORT: "1" }).port).toBe(1);
    expect(loadMcpConfig({ MCP_PORT: "65535" }).port).toBe(65535);
  });

  it.each(["not a url", "::::", "http://["])("fails actionably on an unparseable API_BASE_URL: %s", (value) => {
    expect(() => loadMcpConfig({ API_BASE_URL: value })).toThrow(`Invalid API_BASE_URL: ${value}`);
  });

  it("falls back to the default API origin for a whitespace-only value", () => {
    expect(loadMcpConfig({ API_BASE_URL: "   " }).apiBaseUrl).toBe("http://127.0.0.1:3000");
  });

  it("defaults the host to loopback, not a wildcard address", () => {
    expect(loadMcpConfig({}).host).toBe("127.0.0.1");
  });
});
