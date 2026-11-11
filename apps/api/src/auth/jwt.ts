import { errors, jwtVerify, SignJWT } from "jose";

export async function verifySubject(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        algorithms: ["HS256"],
        requiredClaims: ["sub"],
      },
    );
    // The database primary key is a UUID; reject malformed subjects before SQL.
    return typeof payload.sub === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        payload.sub,
      )
      ? payload.sub
      : null;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

export function signToken(userId: string, secret: string): Promise<string> {
  // Deliberately no expiry or personal claims in the approved local-demo contract.
  // https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .sign(new TextEncoder().encode(secret));
}
