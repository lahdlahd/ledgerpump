import "dotenv/config";
import { hexToBytes } from "@qorechain/rdk";
import { reconcile } from "../../src/reconcile.js";
import type { DailyReport } from "../../src/types.js";
import {
  encodePost,
  encryptReport,
  sha256Hex,
  signLeaf,
  stationKeypair,
  type ReportLeaf,
} from "../../src/crypto.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { exists, readJson, secret, writeFile } from "./lib/files.js";

// Submit one station-day the LedgerPump way:
//   1. reconcile on the "station's device"
//   2. encrypt the full report to the owner's ML-KEM-1024 key from the chain's KEM registry
//   3. store the ciphertext off-chain (rollup/store/)
//   4. sign the leaf (stationId, date, ciphertextHash, status) with the station's ML-DSA-87 key
//   5. post the signed leaf to the rollup inbox
//
// Usage: npm run post-report -- [index]   (index into data/sample/reports.json, default 0)
async function main(): Promise<void> {
  const index = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? 0);
  const report = readJson<DailyReport[]>("../data/sample/reports.json")[index];
  if (!report) throw new Error(`No report at index ${index}`);

  const client = getClient();
  const tx = await connectOperator(client);
  const ctx = { chainId: client.network.chainId, rollupId: ROLLUP_ID };

  // Readers: the owner (operator address), using the key the chain has registered.
  const kem = await client.rest.getKemKey(tx.address).catch(() => undefined);
  if (!kem) throw new Error("Owner has no ML-KEM-1024 key on chain. Run: npm run keys && npm run register-kem");
  const readers = [{ member: tx.address, encapsulationKey: hexToBytes(kem.publicKey) }];
  // The auditor, if configured: a separate account whose key is also read from the chain.
  const auditor = process.env.LP_AUDITOR_ADDRESS;
  if (auditor) {
    const akem = await client.rest.getKemKey(auditor).catch(() => undefined);
    if (!akem) throw new Error(`Auditor ${auditor} has no ML-KEM-1024 key on chain. Run: npm run register-kem -- auditor`);
    readers.push({ member: auditor, encapsulationKey: hexToBytes(akem.publicKey) });
  }

  // One submission per station-day unless --resubmit (a resubmission is kept, never overwritten,
  // and the watchtower shows it as a duplicate).
  const dayDir = `store/${report.stationId}/${report.date}`;
  if (exists(dayDir) && !process.argv.includes("--resubmit")) {
    throw new Error(`${report.stationId} ${report.date} was already submitted. Use --resubmit to post it again.`);
  }

  const result = reconcile(report);
  const envelope = encryptReport(ctx, report, readers);
  // Content-addressed: the file name is the hash the leaf commits to.
  const storePath = `${dayDir}/${sha256Hex(envelope)}.bin`;
  writeFile(storePath, envelope);

  const leaf: ReportLeaf = {
    v: 2,
    stationId: report.stationId,
    date: report.date,
    ciphertextHash: sha256Hex(envelope),
    status: result.status,
  };
  const station = stationKeypair(secret(`station-${report.stationId}.mldsa87.seed`, 32));
  const post = encodePost(leaf, signLeaf(ctx, leaf, station.secretKey));

  const res = await tx.postRollupData({ rollupId: ROLLUP_ID, data: post });
  const inbox = await client.rest.getInbox(ROLLUP_ID);
  console.log(`${report.stationId} ${report.date}: ${result.status}`);
  console.log(`  readers: ${readers.map((r) => r.member).join(", ")}`);
  console.log(`  ciphertext: ${envelope.length} bytes → rollup/${storePath}`);
  console.log(`  ciphertext SHA-256: ${leaf.ciphertextHash}`);
  console.log(`  post: ${post.length} bytes (leaf + ML-DSA-87 signature), SHA-256 ${sha256Hex(post)}`);
  console.log(`  posted: ${res.transactionHash} (code ${res.code}) at height ${res.height}; inbox head ${inbox.headSequence}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
