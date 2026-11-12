import { type Ad, adFormats, adStatuses, niches } from "./model.js";

export type AdParameters = {
  q: string;
  niche: Ad["niche"] | undefined;
  format: Ad["format"] | undefined;
  status: Ad["status"] | undefined;
  apiKey: string;
  page: number;
  perPage: number;
  offset: number;
};

const recognizedNames = [
  "q",
  "niche",
  "format",
  "status",
  "page",
  "per_page",
  "api_key",
] as const;

function positiveInteger(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// null lets the v0 router map all invalid requests to its generic 400 response.
export function parseAdParameters(query: URLSearchParams): AdParameters | null {
  if (recognizedNames.some((name) => query.getAll(name).length > 1))
    return null;
  const apiKey = query.get("api_key");
  if (apiKey === null || apiKey === "") return null;

  const page = positiveInteger(query.get("page"), 1);
  const requestedPerPage = positiveInteger(query.get("per_page"), 20);
  if (page === null || requestedPerPage === null) return null;
  const perPage = Math.min(requestedPerPage, 100);
  const offset = (page - 1) * perPage;
  if (!Number.isSafeInteger(offset)) return null;

  const niche = query.get("niche")?.toLowerCase();
  return {
    q: query.get("q") ?? "",
    niche: niches.find(
      ({ slug, name }) => slug === niche || name.toLowerCase() === niche,
    )?.slug,
    format: adFormats.find((format) => format === query.get("format")),
    status: adStatuses.find((status) => status === query.get("status")),
    apiKey,
    page,
    perPage,
    offset,
  };
}
