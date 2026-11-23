// Claim from PayoutGateV2: ZK proof of reconciliation + the station's ML-DSA-87 signature.
//   npm run claim-v2 -- <stationId> <date>                 prove, sign, simulate, claim if accepted
//   npm run claim-v2 -- <stationId> <date> --record        if refused, send anyway so the refusal is on-chain
//   npm run claim-v2 -- <stationId> <date> --forge-sig     flip one byte of the station's signature
//                                                          (shows the chain's pqcVerify rejecting it)
import { readFileSync } from "node:fs";
import { decodeErrorResult, bytesToHex, hexToBytes, type Hex } from "viem";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { proveReport, solidityCalldata } from "../../zk/src/prove.ts";
import { evmIdentity, openWindow, windowStatus, readJson, writeJson, exists, here } from "./lib/chain.mts";
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
  const forge = process.argv.includes("--forge-sig");
  const record = process.argv.includes("--record") || forge;
  if (!stationId || !date) throw new Error("Usage: npm run claim-v2 -- <stationId> <YYYY-MM-DD> [--record] [--forge-sig]");
  if (!exists("deployment-v2.json")) throw new Error("Not deployed yet: run npm run deploy-v2 first");
  const dep = readJson<{ gate: Hex }>("deployment-v2.json");
  const report = (JSON.parse(readFileSync(here("../data/sample/reports.json"), "utf8")) as DailyReport[]).find((r) => r.stationId === stationId && r.date === date);
  if (!report) throw new Error(`No report for ${stationId} ${date}`);

  // The station's own ML-DSA-87 key: the one that signs its rollup leaves.
  const seedPath = here(`../rollup/keys/station-${stationId}.mldsa87.seed`);
  const station = ml_dsa87.keygen(new Uint8Array(Buffer.from(readFileSync(seedPath, "utf8").trim(), "hex")));
  const registry = JSON.parse(readFileSync(here("../rollup/registry/stations.json"), "utf8")) as Record<string, { mldsa87PublicKey: string }>;
  if (bytesToHex(station.publicKey).slice(2) !== registry[stationId]?.mldsa87PublicKey) throw new Error(`Station key for ${stationId} doesn't match the registry`);

  const t0 = Date.now();
  const p = await proveReport(report);
  console.log(`Proof generated in ${Date.now() - t0} ms: reconciled = ${p.reconciled ? 1 : 0}`);
  const [a, b, c, pub] = await solidityCalldata(p);

  const { abi } = artifact("PayoutGateV2");
  const id = await evmIdentity();
  const message = (await id.publicClient.readContract({ address: dep.gate, abi, functionName: "claimMessage", args: [stationId, date, BigInt(pub[0])] })) as Hex;
  let sig = ml_dsa87.sign(hexToBytes(message), station.secretKey);
  if (forge) { sig = sig.slice(); sig[10] ^= 1; }
  console.log(`Station ${stationId} signed the claim with ML-DSA-87 (${sig.length} B)${forge ? "  [FORGED: one byte flipped]" : ""}`);

  let w = await windowStatus(id.cosmos);
  if (!w.live || w.remainingTxs < 1n) {
    const tx = await openWindow(id, { blocks: 1200, maxTxs: 10, maxValueUqor: 1_000_000n });
    console.log(`EVM window opened: ${tx}`);
    for (let i = 0; i < 20 && !(w = await windowStatus(id.cosmos)).live; i++) await new Promise((r) => setTimeout(r, 3000));
  }

  const call = {
    address: dep.gate, abi, functionName: "claim",
    args: [stationId, date, { a, b, c, pub }, bytesToHex(station.publicKey), bytesToHex(sig)],
    account: id.account, chain: undefined,
  } as const;

  let refused: string | undefined;
  try {
    await id.publicClient.simulateContract(call as any);
  } catch (e) {
    refused = errorName(e, abi);
  }
  if (refused && !record) {
    console.log(`REFUSED by PayoutGateV2: ${refused}  (not sent; add --record to put the refusal on-chain)`);
    process.exit(3);
  }

  const hash = await id.walletClient.writeContract({ ...(call as any), gas: 1_500_000n });
  const rc = await id.publicClient.waitForTransactionReceipt({ hash });
  const ok = rc.status === "success";
  console.log(`${ok ? "PAID" : `REFUSED on-chain (${refused})`}: ${stationId} ${date}  tx ${hash}  block ${rc.blockNumber}  gas ${rc.gasUsed}`);
  const log = exists("claims-v2.json") ? readJson<any[]>("claims-v2.json") : [];
  log.push({ stationId, date, reconciled: p.reconciled, forgedSignature: forge, commitment: p.commitment, leafId: p.leafId, tx: hash, block: Number(rc.blockNumber), status: ok ? "paid" : "refused", reason: refused ?? null, gasUsed: Number(rc.gasUsed), at: new Date().toISOString() });
  writeJson("claims-v2.json", log);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
