import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store";
import type { TestAccount } from "./types";

// Cached Playwright logins (data/auth/<accountId>.json, 0600) + login URL resolution.

export const AUTH_DIR = path.join(DATA_DIR, "auth");

export const authFile = (accountId: string) => path.join(AUTH_DIR, `${accountId.replace(/[^\w-]/g, "")}.json`);

export const clearAuth = (accountId: string) => fs.rmSync(authFile(accountId), { force: true });

// loginUrl may be relative ("/login") — resolve against the frontend.
export const loginHref = (acc: TestAccount, frontendUrl: string) => new URL(acc.loginUrl || "/", frontendUrl).href;

const origin = (u: string, base?: string) => {
  try {
    return new URL(u, base).origin;
  } catch {
    return "";
  }
};

// True when the account would now log in somewhere else than before.
export const loginOriginChanged = (prev: TestAccount, next: TestAccount, prevFront: string, nextFront: string) =>
  origin(prev.loginUrl, prevFront) !== origin(next.loginUrl, nextFront);
