// Pure-TS bcrypt port (vendored bcrypt.js 2.4.3 algorithm, Apache-2.0).
// Exposes the bcrypt ($2b$ hash) contract without a native dependency.
import { randomBytes, timingSafeEqual } from "node:crypto";
import bcryptUntyped from "./bcryptjs.js";

// bcryptjs.ts is vendored JS (untyped); expose the small surface we use.
const bcrypt = bcryptUntyped as {
  setRandomFallback(fn: (len: number) => number[]): void;
  genSaltSync(rounds?: number, seed_length?: number): string;
  hashSync(s: string, salt: string): string;
};

// bcryptjs detects node `crypto` via the CommonJS `module`/`require` globals,
// which do not exist in ESM — wire the fallback to node:crypto instead.
bcrypt.setRandomFallback((len: number) =>
  Array.from(randomBytes(len) as unknown as ArrayLike<number>),
);

const BCRYPT_COST = 12;

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(BCRYPT_COST));
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    if (typeof hashed !== "string" || !hashed.startsWith("$2")) return false;
    const expected = Buffer.from(bcrypt.hashSync(plain, hashed));
    const actual = Buffer.from(hashed);
    // hashSync(s, hash) reuses the salt embedded in `hashed`, so equal
    // outputs mean the password matches.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
