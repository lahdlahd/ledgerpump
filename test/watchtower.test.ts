import { describe, expect, it } from "vitest";
import { kemKeypairFromSeed } from "@qorechain/rdk";
import { canonicalJson, encodePost, encryptReport, sha256Hex, signLeaf, stationKeypair, type ReportLeaf } from "../src/crypto";
import { reconcile } from "../src/reconcile";
import { watch, type InboxPost } from "../src/watchtower";
import { generate } from "../data/generate";

const ctx = { chainId: "qorechain-diana", rollupId: "ledgerpump" };
const operator = "qor1operator";
const data = generate(2026);
const ngt = stationKeypair(new Uint8Array(32).fill(1));
const readers = [{ member: operator, encapsulationKey: kemKeypairFromSeed(new Uint8Array(64).fill(2)).publicKey }];
const enc = new TextEncoder();

function scenario() {
  const store = new Map<string, Uint8Array>();
  const posts: InboxPost[] = [];
  let seq = 0;
  const anchor = (stationId: string, pub: Uint8Array, poster = operator) =>
    posts.push({ sequence: ++seq, poster, payload: enc.encode("LPS1" + canonicalJson({ v: 1, stationId, mldsa87Fingerprint: sha256Hex(pub) })) });
  const report = (i: number, sk = ngt.secretKey, statusOverride?: ReportLeaf["status"]) => {
    const r = data.reports[i];
    const envelope = encryptReport(ctx, r, readers);
    store.set(`${r.stationId}|${r.date}`, envelope);
    const leaf: ReportLeaf = { v: 2, stationId: r.stationId, date: r.date, ciphertextHash: sha256Hex(envelope), status: statusOverride ?? reconcile(r).status };
    posts.push({ sequence: ++seq, poster: operator, payload: encodePost(leaf, signLeaf(ctx, leaf, sk)) });
  };
  const run = () =>
    watch({ ctx, operator, posts, stationKeys: { "NGT-LAG-01": ngt.publicKey }, loadCiphertext: (s, d) => store.get(`${s}|${d}`) });
  return { store, posts, anchor, report, run };
}

const kinds = (f: { kind: string }[]) => f.map((x) => x.kind);

describe("watchtower tier 1 (no decryption)", () => {
  it("accepts honest, anchored, signed reports and flags the planted discrepancy", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey);
    s.report(0);
    s.report(7); // day 8: the 600 L meter-vs-tank loss
    expect(kinds(s.run())).toEqual(["station_anchored", "ok", "discrepancy_reported"]);
  });

  it("catches a stored report edited after it was committed", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey);
    s.report(0);
    const k = `${data.reports[0].stationId}|${data.reports[0].date}`;
    const t = s.store.get(k)!.slice();
    t[t.length - 1] ^= 0xff;
    s.store.set(k, t);
    expect(kinds(s.run())).toEqual(["station_anchored", "ciphertext_tampered"]);
  });

  it("catches a deleted ciphertext", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey);
    s.report(0);
    s.store.clear();
    expect(kinds(s.run())).toContain("ciphertext_missing");
  });

  it("rejects a report signed by a key other than the anchored station key", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey);
    s.report(0, stationKeypair(new Uint8Array(32).fill(9)).secretKey);
    expect(kinds(s.run())).toEqual(["station_anchored", "bad_signature"]);
  });

  it("rejects reports from a station with no on-chain key anchor", () => {
    const s = scenario();
    s.report(0);
    expect(kinds(s.run())).toEqual(["unknown_station"]);
  });

  it("ignores key anchors not posted by the operator", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey, "qor1attacker");
    s.report(0);
    expect(kinds(s.run())).toEqual(["anchor_not_from_operator", "unknown_station"]);
  });

  it("flags duplicate submissions for the same station-day", () => {
    const s = scenario();
    s.anchor("NGT-LAG-01", ngt.publicKey);
    s.report(0);
    s.report(0);
    expect(kinds(s.run())).toContain("duplicate_submission");
  });

  it("skips posts that are not LedgerPump v2 reports", () => {
    const s = scenario();
    s.posts.push({ sequence: 99, poster: operator, payload: enc.encode('LPR1{"v":1}') });
    expect(s.run()).toEqual([]);
  });
});
