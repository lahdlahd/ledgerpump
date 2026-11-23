// Fixtures for the PayoutGateV3 tests (evm/test/fixtures-v3.json): real Groth16 proofs plus
// v3 rollup leaves signed with the production signing code (src/crypto.ts), so the tests check
// that the contract rebuilds the exact bytes a station signs. Test keys only (fixed seeds).
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { generate } from "../../data/generate";
import { reconcile } from "../../src/reconcile";
import { leafSigningMessage, signLeaf, stationKeypair, type ReportLeaf } from "../../src/crypto";
import { proveReport, solidityCalldata } from "../src/prove";

const ctx = { chainId: "qorechain-diana", rollupId: "ledgerpump" };
const station = stationKeypair(new Uint8Array(32).fill(11));
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const reports = generate(2026).reports;
const pick = (s: string, d: string) => reports.find((r) => r.stationId === s && r.date === d)!;

const out: Record<string, unknown> = { ctx, stationPubkey: hex(station.publicKey) };
const cases = [
  ["clean", "NGT-LAG-01", "2026-11-01", undefined],
  ["theft", "NGT-LAG-01", "2026-11-08", undefined],
  // A station that lies in its signed leaf: says within_tolerance on the theft day.
  ["theftLying", "NGT-LAG-01", "2026-11-08", "within_tolerance"],
  ["clean2", "HLT-AKR-01", "2026-11-02", undefined],
] as const;
for (const [name, s, d, statusOverride] of cases) {
  const report = pick(s, d);
  const p = await proveReport(report);
  const [a, b, c, pub] = await solidityCalldata(p);
  const leaf: ReportLeaf = {
    v: 3,
    stationId: s,
    date: d,
    ciphertextHash: createHash("sha256").update(`ciphertext|${s}|${d}`).digest("hex"),
    status: statusOverride ?? reconcile(report).status,
    zkCommitment: p.commitment,
  };
  out[name] = {
    leaf: { stationId: leaf.stationId, date: leaf.date, ciphertextHash: leaf.ciphertextHash, status: leaf.status },
    proof: { a, b, c, pub },
    message: hex(leafSigningMessage(ctx, leaf)),
    signature: hex(signLeaf(ctx, leaf, station.secretKey)),
    reconciled: p.reconciled,
  };
}
writeFileSync(new URL("../../evm/test/fixtures-v3.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("v3 fixtures written:", cases.map((c) => c[0]).join(", "));
process.exit(0);
