import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const nginxConfig = readFileSync(
  new URL("../../web/nginx.conf", import.meta.url),
  "utf8",
).replace(/#.*$/gm, "");

it("discards request logs at server scope without location overrides", () => {
  const serverDirectives = nginxConfig.split(/\blocation\b/)[0];
  expect(serverDirectives).toMatch(/^\s*server\s*\{/);
  expect(serverDirectives).toMatch(/\baccess_log\s+off\s*;/);
  expect(serverDirectives).toMatch(/\berror_log\s+\/dev\/null\s*;/);
  expect(nginxConfig.match(/\baccess_log\b/g)).toHaveLength(1);
  expect(nginxConfig.match(/\berror_log\b/g)).toHaveLength(1);
  expect(nginxConfig).not.toMatch(/\binclude\b/);
});

it("preserves API paths and statuses separately from the SPA fallback", () => {
  for (const location of ["= /api", "/api/"]) {
    expect(nginxConfig).toContain(
      `location ${location} {\n    proxy_pass http://api:3000;\n  }`,
    );
  }
  expect(nginxConfig).toContain(
    "location / {\n    try_files $uri $uri/ /index.html;\n  }",
  );
  expect(nginxConfig).not.toMatch(
    /\b(proxy_intercept_errors|error_page|rewrite)\b/,
  );
});
