import type { CursorQuery } from "./cursor.js";
import { adFormats, adStatuses, niches } from "./model.js";
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
      error: { code: "VALIDATION_ERROR" | "INVALID_CURSOR" | "CURSOR_QUERY_MISMATCH"; details: ValidationDetail[] };
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

type ValidatedParameters = Omit<RawParameters, "niche" | "format" | "status" | "sort"> & {
  niche?: CursorQuery["niche"];
  format?: NonNullable<CursorQuery["format"]>;
  status?: NonNullable<CursorQuery["status"]>;
  sort?: CursorQuery["sort"];
};
const nicheSlugs = niches.map(({ slug }) => slug);
const sorts = ["newest", "impressions"] as const;

type SearchParameters = { query: CursorQuery; limit: number; cursor: string | undefined };

// Pass original only after authenticating/decoding the cursor; validation must run first.
export function normalizeV1Parameters(
  value: ValidatedParameters,
  original?: CursorQuery,
): ParameterResult<SearchParameters> {
  const query: CursorQuery = {
    q: value.q !== undefined ? value.q.trim() : (original?.q ?? ""),
    niche: value.niche !== undefined ? [...new Set(value.niche)].sort() : [...(original?.niche ?? [])],
    format: value.format ?? original?.format ?? null,
    status: value.status ?? original?.status ?? null,
    startedAfter: value.started_after ?? original?.startedAfter ?? null,
    brandId: value.brand_id !== undefined ? Number(value.brand_id) : (original?.brandId ?? null),
    sort: value.sort ?? original?.sort ?? "newest",
  };
  // Compare values, not object serialization/order. Omitted fields already inherit originals.
  if (
    original &&
    (query.q !== original.q ||
      query.niche.length !== original.niche.length ||
      query.niche.some((slug, index) => slug !== original.niche[index]) ||
      query.format !== original.format ||
      query.status !== original.status ||
      query.startedAfter !== original.startedAfter ||
      query.brandId !== original.brandId ||
      query.sort !== original.sort)
  ) {
    return { error: { code: "CURSOR_QUERY_MISMATCH", details: [] } };
  }
  if (query.sort === "impressions" && query.brandId === null) {
    return invalid("brand_id", "required_for_impressions");
  }
  return { value: { query, limit: value.limit === undefined ? 20 : Number(value.limit), cursor: value.cursor } };
}

// Validation checks supplied values only. Defaults, conversions and deduplication come later.
export function validateV1Parameters(raw: RawParameters): ParameterResult<ValidatedParameters> {
  const value: ValidatedParameters = {};
  if (raw.q !== undefined) {
    if (raw.q.includes("\0")) return invalid("q", "invalid_text");
    if ([...raw.q.trim()].length > 500) return invalid("q", "too_long");
    value.q = raw.q;
  }
  if (raw.niche !== undefined) {
    value.niche = [];
    for (const supplied of raw.niche) {
      const slug = nicheSlugs.find((allowed) => allowed === supplied);
      if (!slug) {
        const correction = niches.find(({ name }) => name === supplied)?.slug ?? null;
        return invalid("niche", "invalid_value", nicheSlugs, correction);
      }
      value.niche.push(slug);
    }
  }
  if (raw.format !== undefined) {
    const format = adFormats.find((allowed) => allowed === raw.format);
    if (!format) return invalid("format", "invalid_value", adFormats);
    value.format = format;
  }
  if (raw.status !== undefined) {
    const status = adStatuses.find((allowed) => allowed === raw.status);
    if (!status) return invalid("status", "invalid_value", adStatuses);
    value.status = status;
  }
  if (raw.sort !== undefined) {
    const sort = sorts.find((allowed) => allowed === raw.sort);
    if (!sort) return invalid("sort", "invalid_value", sorts);
    value.sort = sort;
  }
  if (raw.started_after !== undefined) {
    const date = raw.started_after;
    const time = Date.parse(date);
    if (
      !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ||
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== date
    ) {
      return invalid("started_after", "invalid_calendar_date");
    }
    value.started_after = date;
  }
  for (const name of ["brand_id", "limit"] as const) {
    const supplied = raw[name];
    if (supplied === undefined) continue;
    const max = name === "brand_id" ? 2147483647 : 100;
    if (!/^[0-9]+$/.test(supplied) || Number(supplied) < 1 || Number(supplied) > max) {
      return invalid(name, "out_of_range_integer");
    }
    value[name] = supplied;
  }
  if (raw.cursor !== undefined) {
    if (raw.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw.cursor)) {
      return { error: { code: "INVALID_CURSOR", details: [] } };
    }
    value.cursor = raw.cursor;
  }
  return { value };
}
