// Write Solidity-ready proof fixtures for the PayoutGate tests (evm/test/fixtures.json).
import { writeFileSync } from "node:fs";
import { generate } from "../../data/generate";
import { proveReport, solidityCalldata } from "../src/prove";

const reports = generate(2026).reports;
const pick = (s: string, d: string) => reports.find((r) => r.stationId === s && r.date === d)!;
const out: Record<string, unknown> = {};
for (const [name, s, d] of [["clean", "NGT-LAG-01", "2026-11-01"], ["theft", "NGT-LAG-01", "2026-11-08"], ["clean2", "HLT-AKR-01", "2026-11-02"]] as const) {
  const p = await proveReport(pick(s, d));
  const [a, b, c, pub] = await solidityCalldata(p);
  out[name] = { stationId: s, date: d, a, b, c, pub, reconciled: p.reconciled };
}
writeFileSync(new URL("../../evm/test/fixtures.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("fixtures written:", Object.keys(out).join(", "));
