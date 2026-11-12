import { errors, jwtVerify, SignJWT } from "jose";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifySubject(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      requiredClaims: ["sub"],
    });

    const subject = payload.sub;

    // The database primary key is a UUID; reject malformed subjects before SQL.
    if (typeof subject !== "string" || !UUID_PATTERN.test(subject)) {
      return null;
    }

    return subject;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      return null;
    }

    throw error;
  }
}

export function signToken(userId: string, secret: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).sign(new TextEncoder().encode(secret));
}
