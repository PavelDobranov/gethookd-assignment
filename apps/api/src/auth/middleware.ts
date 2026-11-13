import type { NextFunction, Request, Response } from "express";

import { errorBody } from "../shared/errors.js";
import type { createAuthService } from "./service.js";

export type AuthenticatedLocals = {
  user: {
    id: string;
    username: string;
  };
};

export function createRequireAuthentication(auth: Pick<ReturnType<typeof createAuthService>, "getUser">) {
  return async function requireAuthentication(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) {
    const authorization = req.get("authorization") ?? "";
    const bearerMatch = /^Bearer (\S+)$/i.exec(authorization);
    const token = bearerMatch?.[1];

    const user = token ? await auth.getUser(token) : null;

    if (!user) {
      res.status(401).json(errorBody("UNAUTHENTICATED", "Authentication required."));

      return;
    }

    res.locals.user = user;

    next();
  };
}
