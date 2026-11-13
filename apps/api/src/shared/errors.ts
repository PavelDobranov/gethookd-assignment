// The simple error envelope shared by v0-independent endpoints: the global error
// handler, health, and portal auth. v0 keeps its frozen `{ error: "Invalid request" }`
// string; v1 keeps its richer `code/message/next_action/retryable/details` envelope.
export type ErrorBody = { error: { code: string; message: string } };

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
