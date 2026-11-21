import "dotenv/config";
import { decodeQledgerTx } from "@qorechain/rdk";
import { canonicalJson } from "../../src/crypto.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { readJson } from "./lib/files.js";

// Anchor each station's ML-DSA-87 key fingerprint in the rollup inbox ("LPS1"),
// so a report signature can be checked against a key the operator committed
// on-chain, not just a file in the repo.
async function main(): Promise<void> {
  const registry = readJson<Record<string, { fingerprint: string }>>("registry/stations.json");
  const client = getClient();
  const tx = await connectOperator(client);
  for (const [stationId, { fingerprint }] of Object.entries(registry)) {
    const payload = new TextEncoder().encode("LPS1" + canonicalJson({ v: 1, stationId, mldsa87Fingerprint: fingerprint }));
    if (decodeQledgerTx(payload)) throw new Error("payload decodes as a qledger tx");
    const res = await tx.postRollupData({ rollupId: ROLLUP_ID, data: payload });
    console.log(`${stationId} → ${res.transactionHash} (code ${res.code})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
