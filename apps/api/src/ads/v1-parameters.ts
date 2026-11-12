import type { ValidationDetail } from "./v1-errors.js";

const parameterNames = [
  "q",
  "niche",
  "format",
  "status",
  "started_after",
  "brand_id",
  "sort",
  "limit",
  "cursor",
] as const;
type ParameterName = (typeof parameterNames)[number];
type RawParameters = Partial<Record<Exclude<ParameterName, "niche">, string>> & { niche?: string[] };
type ParameterResult<T> =
  | { value: T; error?: never }
  | {
      value?: never;
      error: { code: "VALIDATION_ERROR"; details: ValidationDetail[] };
    };

function invalid(
  parameter: string,
  reason: string,
  allowed_values: readonly string[] = [],
  suggestion: string | null = null,
) {
  return {
    error: {
      code: "VALIDATION_ERROR" as const,
      details: [{ parameter, reason, allowed_values: [...allowed_values], suggestion }],
    },
  };
}

// Read raw URLSearchParams, not Express's parsed query object: brackets stay literal.
export function parseV1Parameters(parameters: URLSearchParams): ParameterResult<RawParameters> {
  const value: RawParameters = {};
  for (const name of parameters.keys()) {
    if (!parameterNames.some((allowed) => allowed === name)) {
      // Unknown names may themselves contain credentials; expose only public corrections.
      return invalid("query", "unknown_parameter", parameterNames, name === "nich" ? "niche" : null);
    }
  }
  for (const name of parameterNames) {
    const values = parameters.getAll(name);
    if (values.length === 0) continue;
    if (name === "niche") value.niche = values;
    else {
      if (values.length !== 1) return invalid(name, "duplicate_parameter");
      value[name] = values[0];
    }
  }
  return { value };
}
