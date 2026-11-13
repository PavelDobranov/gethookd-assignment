import { z } from "zod";

const nichesSchema = z.looseObject({
  data: z.array(z.looseObject({ slug: z.string(), name: z.string() })),
});

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

type ApiResult =
  | { isError: false; body: z.infer<typeof nichesSchema> }
  | { isError: true; body: z.infer<typeof errorSchema> };

/** HTTP-only boundary. No API implementation imports, credentials, retries or redirects. */
export type ApiClient = {
  readonly baseUrl: string;
  listNiches(): Promise<ApiResult>;
};

function operationalError(code: string, message: string): ApiResult {
  return {
    isError: true,
    body: {
      error: {
        code,
        message,
        next_action:
          "Check the API connection and configuration. Delivery outcome is unknown; no automatic retry was made.",
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
  const url = new URL("/api/v1/niches", origin);

  return {
    baseUrl: origin.origin,
    async listNiches() {
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      let body: unknown;
      try {
        response = await fetch(url, { method: "GET", redirect: "error", signal });
        // Keep the deadline active through body delivery, not just response headers.
        const text = await response.text();
        try {
          body = JSON.parse(text);
        } catch {
          return operationalError("API_INVALID_RESPONSE", "The API returned invalid JSON.");
        }
      } catch {
        return signal.aborted
          ? operationalError("API_TIMEOUT", "The API request exceeded its deadline.")
          : operationalError("API_UNAVAILABLE", "The API request could not be completed.");
      }

      // Validate without projecting parsed output: preserve all valid JSON fields.
      if (response.ok && nichesSchema.safeParse(body).success) {
        return { isError: false, body: body as z.infer<typeof nichesSchema> };
      }
      if (!response.ok && errorSchema.safeParse(body).success) {
        return { isError: true, body: body as z.infer<typeof errorSchema> };
      }
      return operationalError("API_INVALID_RESPONSE", "The API returned an invalid response shape.");
    },
  };
}
