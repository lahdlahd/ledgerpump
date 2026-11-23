// Claim from PayoutGateV3. The station's signed v3 leaf is read back from the rollup inbox on
// chain; the ZK proof is regenerated with the salt the station kept when it posted the report,
// so its commitment must equal the one in the signed leaf.
//   npm run claim-v3 -- <stationId> <date>                  claim if the chain accepts
//   npm run claim-v3 -- <stationId> <date> --record         if refused, send anyway (refusal on-chain)
//   npm run claim-v3 -- <stationId> <date> --wrong-figures  prove with a fresh salt, i.e. a commitment
//                                                           that isn't the one in the rollup leaf
import { readFileSync, existsSync } from "node:fs";
import { decodeErrorResult, bytesToHex, type Hex } from "viem";
import { proveReport, solidityCalldata, newSalt } from "../../zk/src/prove.ts";
import { evmIdentity, openWindow, windowStatus, readJson, writeJson, exists, here } from "./lib/chain.mts";
import { findLeaf } from "./lib/leaves.mts";
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
  const wrong = process.argv.includes("--wrong-figures");
  const record = process.argv.includes("--record") || wrong;
  if (!stationId || !date) throw new Error("Usage: npm run claim-v3 -- <stationId> <YYYY-MM-DD> [--record] [--wrong-figures]");
  if (!exists("deployment-v3.json")) throw new Error("Not deployed yet: run npm run deploy-v3 first");
  const dep = readJson<{ gate: Hex }>("deployment-v3.json");
  const report = (JSON.parse(readFileSync(here("../data/sample/reports.json"), "utf8")) as DailyReport[]).find((r) => r.stationId === stationId && r.date === date);
  if (!report) throw new Error(`No report for ${stationId} ${date}`);

  const onChain = await findLeaf(stationId, date);
  console.log(`Rollup inbox #${onChain.sequence}: signed v3 leaf for ${stationId} ${date}, status ${onChain.leaf.status}, commitment ${onChain.leaf.zkCommitment!.slice(0, 16)}…`);

  const saltsPath = here("../rollup/keys/zk-salts.json");
  const salts = existsSync(saltsPath) ? (JSON.parse(readFileSync(saltsPath, "utf8")) as Record<string, string>) : {};
  const salt = wrong ? newSalt() : BigInt(salts[`${stationId}|${date}`] ?? (() => { throw new Error(`No salt for ${stationId} ${date} in rollup/keys/zk-salts.json`); })());
  const t0 = Date.now();
  const p = await proveReport(report, salt);
  const matches = p.commitment === onChain.leaf.zkCommitment;
  console.log(`Proof generated in ${Date.now() - t0} ms: reconciled = ${p.reconciled ? 1 : 0}, commitment ${matches ? "matches the rollup leaf" : "DOES NOT match the rollup leaf"}${wrong ? "  [--wrong-figures]" : ""}`);
  const [a, b, c, pub] = await solidityCalldata(p);

  const { abi } = artifact("PayoutGateV3");
  const id = await evmIdentity();
  let w = await windowStatus(id.cosmos);
  if (!w.live || w.remainingTxs < 1n) {
    const tx = await openWindow(id, { blocks: 1200, maxTxs: 10, maxValueUqor: 1_000_000n });
    console.log(`EVM window opened: ${tx}`);
    for (let i = 0; i < 20 && !(w = await windowStatus(id.cosmos)).live; i++) await new Promise((r) => setTimeout(r, 3000));
  }

  const leaf = { stationId, date, ciphertextHash: onChain.leaf.ciphertextHash, status: onChain.leaf.status };
  const call = {
    address: dep.gate, abi, functionName: "claim",
    args: [leaf, { a, b, c, pub }, bytesToHex(onChain.stationPubkey), bytesToHex(onChain.signature)],
    account: id.account, chain: undefined,
  } as const;

  let refused: string | undefined;
  try {
    await id.publicClient.simulateContract(call as any);
  } catch (e) {
    refused = errorName(e, abi);
  }
  if (refused && !record) {
    console.log(`REFUSED by PayoutGateV3: ${refused}  (not sent; add --record to put the refusal on-chain)`);
    process.exit(3);
  }

  const hash = await id.walletClient.writeContract({ ...(call as any), gas: 1_500_000n });
  const rc = await id.publicClient.waitForTransactionReceipt({ hash });
  const ok = rc.status === "success";
  console.log(`${ok ? "PAID" : `REFUSED on-chain (${refused})`}: ${stationId} ${date}  tx ${hash}  block ${rc.blockNumber}`);
  const log = exists("claims-v3.json") ? readJson<any[]>("claims-v3.json") : [];
  log.push({
    stationId, date, inboxSequence: onChain.sequence, leafStatus: onChain.leaf.status, ciphertextHash: onChain.leaf.ciphertextHash,
    leafCommitment: onChain.leaf.zkCommitment, proofCommitment: p.commitment, commitmentMatches: matches, reconciled: p.reconciled,
    tx: hash, block: Number(rc.blockNumber), status: ok ? "paid" : "refused", reason: refused ?? null, at: new Date().toISOString(),
  });
  writeJson("claims-v3.json", log);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
