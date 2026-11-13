import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

const nichesSchema = z.looseObject({
  data: z.array(z.looseObject({ slug: z.string(), name: z.string() })),
});

const adSummarySchema = z.looseObject({
  id: z.string().min(1),
  brand_id: z.number().int().min(1).max(2_147_483_647),
  brand_name: z.string(),
  headline: z.string(),
  niche: z.string(),
  format: z.enum(["image", "video", "carousel"]),
  status: z.enum(["active", "inactive"]),
  start_date: z.iso.date(),
  days_active: z.number().int(),
  impression_rank: z.number().int().positive().nullable(),
});

const adDetailSchema = z.looseObject({
  data: adSummarySchema.extend({
    body_text: z.string(),
    end_date: z.iso.date().nullable(),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
    discovered_at: z.iso.datetime(),
  }),
});

const searchResponseSchema = z.looseObject({
  data: z.array(adSummarySchema).max(100),
  applied_filters: z.looseObject({
    q: z.string(),
    niche: z.array(z.string()),
    format: z.enum(["image", "video", "carousel"]).nullable(),
    status: z.enum(["active", "inactive"]).nullable(),
    started_after: z.iso.date().nullable(),
    brand_id: z.number().int().min(1).max(2_147_483_647).nullable(),
  }),
  sort: z.enum(["newest", "impressions"]),
  limit: z.number().int().min(1).max(100),
  next_cursor: z.string().min(1).max(4096).nullable(),
  cursor_expires_at: z.iso.datetime(),
});

export type SearchAdsInput = {
  q?: string;
  niche?: string[];
  format?: "image" | "video" | "carousel";
  status?: "active" | "inactive";
  started_after?: string;
  brand_id?: number;
  sort?: "newest" | "impressions";
  limit?: number;
  cursor?: string;
  idempotency_key?: string;
};

const errorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    next_action: z.string(),
    retryable: z.boolean(),
    details: z.array(
      z.looseObject({
        parameter: z.string(),
        reason: z.string(),
        allowed_values: z.array(z.string()),
        suggestion: z.string().nullable(),
      }),
    ),
  }),
});

type ApiResult<T> = { isError: false; body: T } | { isError: true; body: z.infer<typeof errorSchema> };

/**
 * HTTP-only boundary. No API implementation imports, stored credentials, retries
 * or redirects. Each call forwards the caller's Bearer credential for that single
 * request; REST remains the sole authority for key state, scopes and billing.
 */
export type ApiClient = {
  readonly baseUrl: string;
  listNiches(authorization: string): Promise<ApiResult<z.infer<typeof nichesSchema>>>;
  getAd(
    input: { id: string; idempotency_key?: string },
    authorization: string,
  ): Promise<ApiResult<z.infer<typeof adDetailSchema>>>;
  searchAds(input: SearchAdsInput, authorization: string): Promise<ApiResult<z.infer<typeof searchResponseSchema>>>;
};

function operationalError(message: string): ApiResult<never> {
  return {
    isError: true,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message,
        next_action:
          "Check the API connection and configuration. Delivery outcome is unknown; no automatic retry was made. For a deliberate search_ads/get_ad retry, reuse the same supplied idempotency_key; without one, another successful call can charge again.",
        retryable: false,
        details: [],
      },
    },
  };
}

export function createApiClient({ baseUrl, timeoutMs = 10_000 }: { baseUrl: string; timeoutMs?: number }): ApiClient {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("Invalid origin");
    }
  } catch {
    throw new Error("API base URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("API timeout must be an integer between 1 and 30000 milliseconds.");
  }
  const transport = origin.protocol === "https:" ? httpsRequest : httpRequest;

  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    authorization: string,
    idempotencyKey?: string,
  ): Promise<ApiResult<T>> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: { status: number; text: string };
    // Forward only the caller's credential (and optional idempotency identity);
    // no unrelated inbound header is passed through, and the key never enters the
    // URL. REST validates the key and resolves scopes, revocation and billing.
    const headers: Record<string, string> = { Authorization: authorization };
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    try {
      response = await new Promise((resolve, reject) => {
        // Keep path separate from the URL: even percent-encoded dot segments
        // are normalized by WHATWG URL/fetch. Node HTTP preserves this path.
        const request = transport(
          origin,
          {
            method: "GET",
            path,
            signal,
            headers,
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () => {
              resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        // The abort signal bounds the entire exchange, including the body.
        // Node HTTP neither follows redirects nor automatically retries.
        request.once("error", reject);
        request.end();
      });
    } catch {
      return signal.aborted
        ? operationalError("The API request exceeded its deadline.")
        : operationalError("The API request could not be completed.");
    }

    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      return operationalError("The API returned invalid JSON.");
    }
    // Validate without projecting parsed output: preserve all valid JSON fields.
    const ok = response.status >= 200 && response.status < 300;
    if (ok && schema.safeParse(body).success) {
      return { isError: false, body: body as T };
    }
    if (!ok && errorSchema.safeParse(body).success) {
      return { isError: true, body: body as z.infer<typeof errorSchema> };
    }
    return operationalError("The API returned an invalid response shape.");
  }

  return {
    baseUrl: origin.origin,
    listNiches: (authorization) => get("/api/v1/niches", nichesSchema, authorization),
    getAd({ id, idempotency_key }, authorization) {
      const segment = id === "." || id === ".." ? id.replaceAll(".", "%2E") : encodeURIComponent(id);
      return get(`/api/v1/ads/${segment}`, adDetailSchema, authorization, idempotency_key);
    },
    searchAds({ idempotency_key, ...filters }, authorization) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(filters)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const niche of value) query.append(name, niche);
        } else {
          query.append(name, String(value));
        }
      }
      const suffix = query.size === 0 ? "" : `?${query}`;
      return get(`/api/v1/ads${suffix}`, searchResponseSchema, authorization, idempotency_key);
    },
  };
}
