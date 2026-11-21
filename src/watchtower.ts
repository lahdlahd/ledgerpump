// LedgerPump watchtower, tier 1 (public): works on public data only (inbox
// commitments, stored ciphertexts, the station key registry) and never decrypts.

import { createHash } from "node:crypto";
import { decodePost, verifyLeaf, type ReportLeaf, type RollupCtx } from "./crypto";

export interface InboxPost {
  sequence: number;
  poster: string;
  payload: Uint8Array;
}

export type FindingKind =
  | "ok"
  | "station_anchored"
  | "anchor_not_from_operator"
  | "anchor_mismatch"
  | "unknown_station"
  | "bad_signature"
  | "ciphertext_missing"
  | "ciphertext_tampered"
  | "duplicate_submission"
  | "discrepancy_reported";

export interface Finding {
  kind: FindingKind;
  severity: "info" | "warn" | "alert";
  sequence: number;
  stationId?: string;
  date?: string;
  detail?: string;
}

export interface WatchInput {
  ctx: RollupCtx;
  operator: string;
  posts: InboxPost[];
  /** stationId → ML-DSA-87 public key (from rollup/registry/stations.json). */
  stationKeys: Record<string, Uint8Array>;
  /** The off-chain ciphertext store, content-addressed by the committed hash. */
  loadCiphertext: (stationId: string, date: string, ciphertextHash: string) => Uint8Array | undefined;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder();

export function watch(input: WatchInput): Finding[] {
  const out: Finding[] = [];
  const anchors = new Map<string, string>(); // stationId → fingerprint committed on-chain by the operator
  const seen = new Map<string, number>(); // stationId|date → first sequence

  for (const p of input.posts) {
    const magic = dec.decode(p.payload.subarray(0, 4));

    if (magic === "LPS1") {
      const a = JSON.parse(dec.decode(p.payload.subarray(4))) as { stationId: string; mldsa87Fingerprint: string };
      if (p.poster !== input.operator) {
        out.push({ kind: "anchor_not_from_operator", severity: "alert", sequence: p.sequence, stationId: a.stationId, detail: p.poster });
        continue;
      }
      anchors.set(a.stationId, a.mldsa87Fingerprint);
      const key = input.stationKeys[a.stationId];
      const ok = key && sha256(key) === a.mldsa87Fingerprint;
      out.push(
        ok
          ? { kind: "station_anchored", severity: "info", sequence: p.sequence, stationId: a.stationId }
          : { kind: "anchor_mismatch", severity: "alert", sequence: p.sequence, stationId: a.stationId, detail: "registry key does not match the on-chain fingerprint" },
      );
      continue;
    }

    const post = decodePost(p.payload);
    if (!post) continue; // not a LedgerPump v2 report (e.g. an earlier v1 test post or a ledger tx)
    const { leaf, signature } = post;
    const base = { sequence: p.sequence, stationId: leaf.stationId, date: leaf.date };

    const key = input.stationKeys[leaf.stationId];
    const anchored = anchors.get(leaf.stationId);
    if (!key || !anchored || sha256(key) !== anchored) {
      out.push({ ...base, kind: "unknown_station", severity: "alert", detail: "no on-chain key anchor for this station" });
      continue;
    }
    if (!verifyLeaf(input.ctx, leaf as ReportLeaf, signature, key)) {
      out.push({ ...base, kind: "bad_signature", severity: "alert" });
      continue;
    }

    const k = `${leaf.stationId}|${leaf.date}`;
    if (seen.has(k)) {
      out.push({ ...base, kind: "duplicate_submission", severity: "warn", detail: `first posted at sequence ${seen.get(k)}` });
    } else seen.set(k, p.sequence);

    const ct = input.loadCiphertext(leaf.stationId, leaf.date, leaf.ciphertextHash);
    if (!ct) {
      out.push({ ...base, kind: "ciphertext_missing", severity: "alert" });
      continue;
    }
    if (sha256(ct) !== leaf.ciphertextHash) {
      out.push({ ...base, kind: "ciphertext_tampered", severity: "alert", detail: `stored ${sha256(ct).slice(0, 16)}…, committed ${leaf.ciphertextHash.slice(0, 16)}…` });
      continue;
    }
    out.push(
      leaf.status === "discrepancy"
        ? { ...base, kind: "discrepancy_reported", severity: "warn", detail: "station-day does not qualify for payout" }
        : { ...base, kind: "ok", severity: "info", detail: leaf.status },
    );
  }
  return out;
}
