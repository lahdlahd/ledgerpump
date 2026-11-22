import "dotenv/config";
import { buildSettlementReceipt, isBatchFinal, verifySettlementReceipt, type BatchStatus, type SettlementReceipt } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { allBatches } from "./lib/batches.js";
import { exists, readJson, writeFile } from "./lib/files.js";

// Settlement receipts: portable proof that a LedgerPump batch's state root was
// anchored on QoreChain, signed with the rollup creator's ML-DSA-87
// (Dilithium-5) key.
//
//   npm run receipt                     build a receipt for every finalised batch
//                                       and verify it against live chain state
//   npm run receipt -- <file.json>      verify a receipt someone handed you
//
// Receipts are saved in rollup/receipts/ (public, safe to commit). Verification
// never trusts the file: it re-reads the rollup's layer, the batch root, the
// anchor and the creator's key from the chain.

function show(label: string, v: Awaited<ReturnType<typeof verifySettlementReceipt>>) {
  const mark = (b: boolean) => (b ? "OK " : "XX ");
  console.log(`${v.valid ? "OK " : "XX "} ${label}: ${v.valid ? "VALID" : "INVALID"} (mode ${v.mode}${v.signBytesVersion ? `, anchor ${v.signBytesVersion}` : ""})`);
  for (const [k, ok] of Object.entries(v.checks)) console.log(`      ${mark(ok)}${k}`);
  if (v.reason) console.log(`      reason: ${v.reason}`);
}

async function main(): Promise<void> {
  const client = getClient();
  const file = process.argv.slice(2).find((a) => a.endsWith(".json"));
  if (file) {
    const receipt = readJson<SettlementReceipt>(file);
    show(`${file} (batch ${receipt.batchIndex})`, await verifySettlementReceipt(receipt, { client }));
    return;
  }

  for (const b of await allBatches(client)) {
    if (b.status === "rejected") {
      console.log(`--  batch ${b.batchIndex}: rejected (forged), no receipt`);
      continue;
    }
    if (!isBatchFinal(b.status as BatchStatus)) {
      console.log(`..  batch ${b.batchIndex}: ${b.status}, receipt after finality`);
      continue;
    }
    const path = `receipts/batch-${b.batchIndex}.json`;
    let receipt: SettlementReceipt;
    if (exists(path)) receipt = readJson(path);
    else {
      try {
        receipt = await buildSettlementReceipt(client, ROLLUP_ID, b.batchIndex);
      } catch (e) {
        console.log(`XX  batch ${b.batchIndex}: could not build a receipt: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      writeFile(path, JSON.stringify(receipt, null, 2));
    }
    const v = await verifySettlementReceipt(receipt, { client });
    show(`batch ${b.batchIndex} → rollup/${path}`, v);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
