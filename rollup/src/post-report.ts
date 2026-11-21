import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeQledgerTx } from "@qorechain/rdk";
import { reconcile } from "../../src/reconcile.js";
import type { DailyReport } from "../../src/types.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";

// Post one LedgerPump report commitment into the rollup's inbox.
//
// Usage: npm run post-report -- [index]   (index into data/sample/reports.json, default 0)
//
// The payload is a LedgerPump record, not a qledger transaction, so qledger-v1
// execution skips it, yet the chain stores SHA-256(payload), size, poster and
// height, and the next batch's data_hash commits to it.
//
// Interim: `reportHash` is SHA-256 of the plaintext report. Once encryption lands
// it becomes the hash of the ML-KEM/AES ciphertext, and the leaf gains the
// station's ML-DSA-87 signature.

const MAGIC = "LPR1";

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );

async function main(): Promise<void> {
  const index = Number(process.argv[2] ?? 0);
  const reports: DailyReport[] = JSON.parse(
    readFileSync(new URL("../../data/sample/reports.json", import.meta.url), "utf8"),
  );
  const report = reports[index];
  if (!report) throw new Error(`No report at index ${index} (have ${reports.length})`);

  const result = reconcile(report);
  const leaf = {
    v: 1,
    stationId: report.stationId,
    date: report.date,
    reportHash: createHash("sha256").update(canonical(report)).digest("hex"),
    status: result.status,
  };
  const payload = new TextEncoder().encode(MAGIC + canonical(leaf));
  if (decodeQledgerTx(payload)) throw new Error("Payload decodes as a qledger transaction; refusing to post");

  const client = getClient();
  const tx = await connectOperator(client);
  const res = await tx.postRollupData({ rollupId: ROLLUP_ID, data: payload });
  const inbox = await client.rest.getInbox(ROLLUP_ID);

  console.log(`Leaf: ${canonical(leaf)}`);
  console.log(`Payload SHA-256: ${createHash("sha256").update(payload).digest("hex")} (${payload.length} bytes)`);
  console.log(`Posted: ${res.transactionHash} (code ${res.code}) at height ${res.height}`);
  console.log(`Inbox head: ${inbox.headSequence}, consumed: ${inbox.consumedSequence}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
