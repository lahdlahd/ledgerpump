// Prove every report in the synthetic dataset and check the circuit agrees with
// the TypeScript reconciliation engine on every station-day.
import { readFileSync } from "node:fs";
import { generate } from "../../data/generate";
import { reconcile } from "../../src/reconcile";
import { proveReport, verifyProof, VKEY } from "../src/prove";

const vkey = JSON.parse(readFileSync(VKEY, "utf8"));
const reports = generate(2026).reports;
const limit = Number(process.argv[2] ?? reports.length);
let agree = 0, ok = 0;
const t0 = Date.now();
for (const r of reports.slice(0, limit)) {
  const engine = reconcile(r).status !== "discrepancy";
  const p = await proveReport(r);
  const valid = await verifyProof(p, vkey);
  if (valid) ok++;
  if (p.reconciled === engine) agree++;
  else console.log(`MISMATCH ${r.stationId} ${r.date}: engine ${engine}, circuit ${p.reconciled}`);
  if (!engine) console.log(`held: ${r.stationId} ${r.date} → circuit reconciled=${p.reconciled}`);
}
console.log(`${limit} reports: ${ok} proofs valid, ${agree} agree with the engine. ${((Date.now() - t0) / limit).toFixed(0)} ms/proof`);
process.exit(agree === limit && ok === limit ? 0 : 1);
