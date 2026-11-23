// Claim a station-day's payout from PayoutGate with a zero-knowledge proof of reconciliation.
//   npm run claim -- <stationId> <date>              prove, simulate, and claim if the chain accepts
//   npm run claim -- <stationId> <date> --record     if the chain refuses, send it anyway so the
//                                                    refusal is recorded on-chain (failed tx)
import { readFileSync } from "node:fs";
import { decodeErrorResult, type Hex } from "viem";
import { proveReport, solidityCalldata } from "../../zk/src/prove.ts";
import { evmIdentity, readJson, writeJson, exists, here } from "./lib/chain.mts";
import type { DailyReport } from "../../src/types.ts";

const artifact = (name: string) => JSON.parse(readFileSync(here(`artifacts/contracts/${name}.sol/${name}.json`), "utf8")) as { abi: any };

function errorName(e: any, abi: any): string {
  for (let c = e; c; c = c.cause) {
    if (c.data?.errorName) return c.data.errorName;
    const data: Hex | undefined = typeof c.data === "string" ? c.data : c.data?.data;
    if (data?.startsWith("0x") && data.length >= 10) {
      try { return decodeErrorResult({ abi, data }).errorName; } catch { /* keep looking */ }
    }
  }
  return String(e.shortMessage || e.message).split("\n")[0];
}

async function main() {
  const [stationId, date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const record = process.argv.includes("--record");
  if (!stationId || !date) throw new Error("Usage: npm run claim -- <stationId> <YYYY-MM-DD> [--record]");
  if (!exists("deployment.json")) throw new Error("Not deployed yet: run npm run deploy first");
  const dep = readJson<{ gate: Hex }>("deployment.json");
  const report = (JSON.parse(readFileSync(here("../data/sample/reports.json"), "utf8")) as DailyReport[]).find((r) => r.stationId === stationId && r.date === date);
  if (!report) throw new Error(`No report for ${stationId} ${date}`);

  const t0 = Date.now();
  const p = await proveReport(report);
  console.log(`Proof generated in ${Date.now() - t0} ms: reconciled = ${p.reconciled ? 1 : 0}, commitment ${p.commitment.slice(0, 16)}…`);
  const [a, b, c, pub] = await solidityCalldata(p);

  const { abi } = artifact("PayoutGate");
  const id = await evmIdentity();
  const call = { address: dep.gate, abi, functionName: "claim", args: [stationId, date, a, b, c, pub], account: id.account, chain: undefined } as const;

  let refused: string | undefined;
  try {
    await id.publicClient.simulateContract(call as any);
  } catch (e) {
    refused = errorName(e, abi);
  }

  const log = exists("claims.json") ? readJson<any[]>("claims.json") : [];
  if (refused && !record) {
    console.log(`REFUSED by PayoutGate: ${refused}  (not sent; add --record to put the refusal on-chain)`);
    process.exit(3);
  }
  const hash = await id.walletClient.writeContract({ ...(call as any), ...(refused ? { gas: 600_000n } : {}) });
  const rc = await id.publicClient.waitForTransactionReceipt({ hash });
  const ok = rc.status === "success";
  console.log(`${ok ? "PAID" : `REFUSED on-chain (${refused})`}: ${stationId} ${date}  tx ${hash}  block ${rc.blockNumber}  gas ${rc.gasUsed}`);
  log.push({ stationId, date, reconciled: p.reconciled, commitment: p.commitment, leafId: p.leafId, tx: hash, block: Number(rc.blockNumber), status: ok ? "paid" : "refused", reason: refused ?? null, gasUsed: Number(rc.gasUsed), at: new Date().toISOString() });
  writeJson("claims.json", log);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
