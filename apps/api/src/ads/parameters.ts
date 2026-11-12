import { type Ad, adFormats, adStatuses, niches } from "./model.js";

export type AdParameters = {
  q: string;
  niche: Ad["niche"] | undefined;
  format: Ad["format"] | undefined;
  status: Ad["status"] | undefined;
  apiKey: string;
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

// null lets the v0 router map all invalid requests to its generic 400 response.
export function parseAdParameters(query: URLSearchParams): AdParameters | null {
  if (recognizedNames.some((name) => query.getAll(name).length > 1))
    return null;
  const apiKey = query.get("api_key");
  if (apiKey === null || apiKey === "") return null;

  const niche = query.get("niche")?.toLowerCase();
  return {
    q: query.get("q") ?? "",
    niche: niches.find(
      ({ slug, name }) => slug === niche || name.toLowerCase() === niche,
    )?.slug,
    format: adFormats.find((format) => format === query.get("format")),
    status: adStatuses.find((status) => status === query.get("status")),
    apiKey,
  };
}
