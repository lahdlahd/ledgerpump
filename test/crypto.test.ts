import { describe, expect, it } from "vitest";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { decodeQledgerTx, kemKeypairFromSeed } from "@qorechain/rdk";
import {
  decodePost,
  decryptReport,
  encodePost,
  encryptReport,
  MAX_POST_BYTES,
  sha256Hex,
  signLeaf,
  stationKeypair,
  verifyLeaf,
  type ReportLeaf,
} from "../src/crypto";
import { reconcile } from "../src/reconcile";
import { generate } from "../data/generate";

const ctx = { chainId: "qorechain-diana", rollupId: "ledgerpump" };
const seed = (n: number, len: number) => new Uint8Array(len).fill(n);
const report = generate(2026).reports[0];

const owner = { member: "qor1owner", kem: kemKeypairFromSeed(seed(7, 64)) };
const auditor = { member: "qor1auditor", kem: kemKeypairFromSeed(seed(8, 64)) };
const readers = [owner, auditor].map((r) => ({ member: r.member, encapsulationKey: r.kem.publicKey }));
const station = stationKeypair(seed(3, 32));

function makeLeaf(envelope: Uint8Array): ReportLeaf {
  return { v: 2, stationId: report.stationId, date: report.date, ciphertextHash: sha256Hex(envelope), status: reconcile(report).status };
}

describe("report encryption", () => {
  const envelope = encryptReport(ctx, report, readers);

  it("every registered reader can decrypt", () => {
    expect(decryptReport(ctx, envelope, owner.member, seed(7, 64))).toEqual(report);
    expect(decryptReport(ctx, envelope, auditor.member, seed(8, 64))).toEqual(report);
  });

  it("an outsider cannot", () => {
    expect(() => decryptReport(ctx, envelope, "qor1outsider", seed(9, 64))).toThrow();
    expect(() => decryptReport(ctx, envelope, owner.member, seed(9, 64))).toThrow();
  });

  it("is bound to the rollup", () => {
    expect(() => decryptReport({ ...ctx, rollupId: "other" }, envelope, owner.member, seed(7, 64))).toThrow();
  });

  it("detects tampering with the ciphertext", () => {
    const t = envelope.slice();
    t[t.length - 20] ^= 1;
    expect(() => decryptReport(ctx, t, owner.member, seed(7, 64))).toThrow();
    expect(sha256Hex(t)).not.toBe(sha256Hex(envelope));
  });

  it("uses a fresh content key every time (same report, different ciphertext)", () => {
    expect(sha256Hex(encryptReport(ctx, report, readers))).not.toBe(sha256Hex(envelope));
  });

  it("reader keys are real ML-KEM-1024 keys", () => {
    expect(owner.kem.publicKey.length).toBe(1568);
    expect(ml_kem1024.decapsulate(ml_kem1024.encapsulate(owner.kem.publicKey).cipherText, owner.kem.secretKey).length).toBe(32);
  });
});

describe("station signatures and inbox posts", () => {
  const envelope = encryptReport(ctx, report, readers);
  const leaf = makeLeaf(envelope);
  const sig = signLeaf(ctx, leaf, station.secretKey);

  it("verifies with the station key and only that key", () => {
    expect(verifyLeaf(ctx, leaf, sig, station.publicKey)).toBe(true);
    expect(verifyLeaf(ctx, leaf, sig, stationKeypair(seed(4, 32)).publicKey)).toBe(false);
  });

  it("rejects an altered leaf (e.g. a station faking its status)", () => {
    expect(verifyLeaf(ctx, { ...leaf, status: "balanced" === leaf.status ? "discrepancy" : "balanced" }, sig, station.publicKey)).toBe(false);
  });

  it("is bound to chain and rollup", () => {
    expect(verifyLeaf({ ...ctx, rollupId: "other" }, leaf, sig, station.publicKey)).toBe(false);
  });

  it("encodes to a post under the 6 KiB qledger limit that qledger execution ignores", () => {
    const post = encodePost(leaf, sig);
    expect(post.length).toBeLessThanOrEqual(MAX_POST_BYTES);
    expect(decodeQledgerTx(post)).toBeUndefined();
    const back = decodePost(post)!;
    expect(back.leaf).toEqual(leaf);
    expect(verifyLeaf(ctx, back.leaf, back.signature, station.publicKey)).toBe(true);
  });

  it("ignores payloads that are not LedgerPump posts", () => {
    expect(decodePost(new TextEncoder().encode("hello"))).toBeUndefined();
  });
});

describe("leaf v3 (ZK commitment in the signed rollup leaf)", () => {
  const envelope = encryptReport(ctx, { ...report, zkSalt: "12345" }, readers);
  const v3: ReportLeaf = { ...makeLeaf(envelope), v: 3, zkCommitment: "987654321" };

  it("signs and verifies, and the commitment is part of what's signed", () => {
    const sig = signLeaf(ctx, v3, station.secretKey);
    expect(verifyLeaf(ctx, v3, sig, station.publicKey)).toBe(true);
    expect(verifyLeaf(ctx, { ...v3, zkCommitment: "987654322" }, sig, station.publicKey)).toBe(false);
  });

  it("a v2 signature can't be passed off as v3 (version is in the signed message)", () => {
    const v2 = makeLeaf(envelope);
    const sig = signLeaf(ctx, v2, station.secretKey);
    expect(verifyLeaf(ctx, v2, sig, station.publicKey)).toBe(true);
    expect(verifyLeaf(ctx, { ...v2, v: 3 }, sig, station.publicKey)).toBe(false);
  });

  it("round-trips through an inbox post under 6 KiB, and the salt only travels encrypted", () => {
    const post = encodePost(v3, signLeaf(ctx, v3, station.secretKey));
    expect(post.length).toBeLessThanOrEqual(MAX_POST_BYTES);
    expect(decodePost(post)?.leaf).toEqual(v3);
    expect(new TextDecoder().decode(post)).not.toContain("zkSalt");
    expect(decryptReport(ctx, envelope, owner.member, seed(7, 64)).zkSalt).toBe("12345");
  });
});
