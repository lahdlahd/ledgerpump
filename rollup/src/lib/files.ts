import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths are relative to the rollup/ folder. */
export const here = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(here(p), "utf8")) as T;
}

export function writeFile(p: string, data: string | Uint8Array) {
  mkdirSync(dirname(here(p)), { recursive: true });
  writeFileSync(here(p), data);
}

export const exists = (p: string) => existsSync(here(p));
export const readBytes = (p: string) => new Uint8Array(readFileSync(here(p)));

/** Load a hex secret from rollup/keys/, creating it with fresh randomness the first time. */
export function secret(name: string, bytes: number): Uint8Array {
  const p = `keys/${name}`;
  if (!exists(p)) writeFile(p, randomBytes(bytes).toString("hex"));
  return new Uint8Array(Buffer.from(readFileSync(here(p), "utf8").trim(), "hex"));
}
