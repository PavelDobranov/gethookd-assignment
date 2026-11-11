import { SignJWT } from "jose";

export function signToken(userId: string, secret: string): Promise<string> {
  // Deliberately no expiry or personal claims in the approved local-demo contract.
  // https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .sign(new TextEncoder().encode(secret));
}
