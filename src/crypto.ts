// LedgerPump post-quantum cryptography.
//
// - Stations sign report leaves with ML-DSA-87 (FIPS 204).
// - Reports are encrypted for their readers (owner, auditor) with QoreChain's
//   envelope format: a fresh AES-256-GCM content key per report, wrapped for each
//   reader with ML-KEM-1024 (FIPS 203) against the reader's key in the chain's
//   KEM registry.
// - The on-chain leaf commits to SHA-256 of the *ciphertext*, never the
//   plaintext: sales figures are guessable enough that a plaintext hash could be
//   brute-forced.

import { createHash } from "node:crypto";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { decodeQledgerTx, openEnvelope, sealEnvelope, type EnvelopeRecipient } from "@qorechain/rdk";
import type { DailyReport, Status } from "./types";

export const POST_MAGIC = "LPR2";
/** qledger-v1 accepts posts up to 6 KiB. */
export const MAX_POST_BYTES = 6 * 1024;

export interface RollupCtx {
  chainId: string;
  rollupId: string;
}

export interface ReportLeaf {
  /** v2: original leaf. v3: adds zkCommitment, binding the leaf to a ZK proof of reconciliation. */
  v: 2 | 3;
  stationId: string;
  date: string;
  /** SHA-256 (hex) of the encrypted report envelope. */
  ciphertextHash: string;
  status: Status;
  /** v3 only: Poseidon commitment (decimal) to the day's figures and a salt kept inside the
   *  encrypted report. PayoutGateV3 pays only for a proof over this exact commitment. */
  zkCommitment?: string;
}

export const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Deterministic JSON: object keys sorted at every level. */
export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Uint8Array)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Station identity (ML-DSA-87) ────────────────────────────────────────────

export function stationKeypair(seed: Uint8Array) {
  if (seed.length !== 32) throw new Error(`ML-DSA-87 seed must be 32 bytes, got ${seed.length}`);
  return ml_dsa87.keygen(seed);
}

/** What a station signs: the leaf bound to one chain and one rollup. */
export function leafSigningMessage(ctx: RollupCtx, leaf: ReportLeaf): Uint8Array {
  return enc.encode(`ledgerpump/leaf/v${leaf.v}|${ctx.chainId}|${ctx.rollupId}|${canonicalJson(leaf)}`);
}

export const signLeaf = (ctx: RollupCtx, leaf: ReportLeaf, secretKey: Uint8Array) =>
  ml_dsa87.sign(leafSigningMessage(ctx, leaf), secretKey);

export function verifyLeaf(ctx: RollupCtx, leaf: ReportLeaf, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ml_dsa87.verify(signature, leafSigningMessage(ctx, leaf), publicKey);
  } catch {
    return false;
  }
}

export const publicKeyFingerprint = (publicKey: Uint8Array) => sha256Hex(publicKey);

// ── Report encryption (ML-KEM-1024 + AES-256-GCM) ───────────────────────────

/** Envelope epoch. LedgerPump's rollup is public, so envelopes use epoch 0 off-chain. */
const EPOCH = 0;

export function encryptReport(ctx: RollupCtx, report: DailyReport, readers: EnvelopeRecipient[]): Uint8Array {
  return sealEnvelope({ ...ctx, epoch: EPOCH, recipients: readers, plaintext: enc.encode(canonicalJson(report)) });
}

export function decryptReport(
  ctx: RollupCtx,
  envelope: Uint8Array,
  member: string,
  decapsulationKey: Uint8Array,
): DailyReport {
  return JSON.parse(dec.decode(openEnvelope({ ...ctx, envelope, member, decapsulationKey })));
}

// ── Inbox post: "LPR2" | u16 leafLen | leaf JSON | ML-DSA-87 signature ─────────

export function encodePost(leaf: ReportLeaf, signature: Uint8Array): Uint8Array {
  const leafBytes = enc.encode(canonicalJson(leaf));
  if (leafBytes.length > 0xffff) throw new Error("leaf too large");
  const out = new Uint8Array(4 + 2 + leafBytes.length + signature.length);
  out.set(enc.encode(POST_MAGIC), 0);
  new DataView(out.buffer).setUint16(4, leafBytes.length);
  out.set(leafBytes, 6);
  out.set(signature, 6 + leafBytes.length);
  if (out.length > MAX_POST_BYTES) throw new Error(`post is ${out.length} bytes, over ${MAX_POST_BYTES}`);
  if (decodeQledgerTx(out)) throw new Error("post decodes as a qledger transaction");
  return out;
}

export function decodePost(payload: Uint8Array): { leaf: ReportLeaf; signature: Uint8Array } | undefined {
  if (payload.length < 6 || dec.decode(payload.subarray(0, 4)) !== POST_MAGIC) return undefined;
  const len = new DataView(payload.buffer, payload.byteOffset).getUint16(4);
  if (6 + len > payload.length) return undefined;
  try {
    const leaf = JSON.parse(dec.decode(payload.subarray(6, 6 + len))) as ReportLeaf;
    return { leaf, signature: payload.slice(6 + len) };
  } catch {
    return undefined;
  }
}
