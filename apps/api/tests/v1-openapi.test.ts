import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, it } from "vitest";
import { parse } from "yaml";

type Schema = Record<string, unknown>;
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  style?: string;
  explode?: boolean;
  schema: Schema;
};
type Operation = {
  parameters?: Parameter[];
  responses: Record<string, { $ref?: string; content?: { "application/json": { schema: Schema } } }>;
};
type Contract = {
  openapi: string;
  security: { BearerApiKey: never[] }[];
  paths: Record<string, { get: Operation }>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content: { "application/json": { schema: Schema } } }>;
    securitySchemes: Record<string, Schema>;
  };
};

const contract: Contract = parse(readFileSync(new URL("../../../docs/openapi/v1.yaml", import.meta.url), "utf8"));

// Ajv resolves schema references; only OpenAPI's response-object reference needs unwrapping.
function validators(document: Contract) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
  return {
    response(path: string, status: number) {
      const response = document.paths[path].get.responses[String(status)];
      if (!response) throw new Error(`Undocumented GET ${path} status ${status}`);
      const resolved = response.$ref
        ? document.components.responses[response.$ref.replace("#/components/responses/", "")]
        : response;
      const schema = resolved.content?.["application/json"].schema;
      if (!schema) throw new Error(`Missing JSON schema for GET ${path} status ${status}`);
      return ajv.compile(schema);
    },
    parameter(parameter: Parameter) {
      return ajv.compile(parameter.schema);
    },
  };
}

const validate = validators(contract);
const paths = ["/api/v1/ads", "/api/v1/ads/{id}", "/api/v1/niches"];

it("compiles every documented response with draft-2020-12 formats and local references", () => {
  expect(contract.openapi).toMatch(/^3\.1\./);
  expect(Object.keys(contract.paths)).toEqual(paths);
  expect(contract.security).toEqual([{ BearerApiKey: [] }]);
  expect(contract.components.securitySchemes.BearerApiKey).toEqual({ type: "http", scheme: "bearer" });
  for (const path of paths) {
    for (const status of Object.keys(contract.paths[path].get.responses)) {
      expect(status).not.toBe("429");
      expect(validate.response(path, Number(status))).toBeTypeOf("function");
    }
  }
});
