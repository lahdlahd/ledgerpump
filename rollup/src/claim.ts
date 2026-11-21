import "dotenv/config";
import { readdirSync } from "node:fs";
import { isBatchFinal, qledgerWithdrawalProof, uqorToQor, type BatchStatus } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { exists, here, readJson, writeFile } from "./lib/files.js";
import { allBatches } from "./lib/batches.js";

// Execute every withdrawal from a finalised batch with its Merkle proof. The
// chain recomputes the batch's withdrawals root from the proof before paying
// from the rollup's deposit pool. Anyone may execute; the operator does it here.
type SavedBatch = {
  input: { batchIndex: string };
  result: { withdrawals: { index: string; recipient: string; amount: string }[] };
};

async function main(): Promise<void> {
  const client = getClient();
  const ctx = { chainId: client.network.chainId, rollupId: ROLLUP_ID };
  const tx = await connectOperator(client);
  const claimed: Record<string, string> = exists("state/claims.json") ? readJson("state/claims.json") : {};
  const files = exists("state/batches") ? readdirSync(here("state/batches")).filter((f) => f.endsWith(".json")) : [];
  const batches = await allBatches(client);

  for (const f of files) {
    const b = readJson<SavedBatch>(`state/batches/${f}`);
    const ws = b.result.withdrawals.map((w) => ({ index: BigInt(w.index), recipient: w.recipient, amount: BigInt(w.amount) }));
    if (!ws.length) continue;
    const onChain = batches.find((x) => String(x.batchIndex) === b.input.batchIndex);
    if (!onChain || !isBatchFinal(onChain.status as BatchStatus)) {
      console.log(`Batch ${b.input.batchIndex}: ${ws.length} withdrawal(s) waiting — batch is ${onChain?.status ?? "unknown"}`);
      continue;
    }
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (claimed[String(w.index)]) continue;
      const res = await tx.executeWithdrawal({
        rollupId: ROLLUP_ID,
        batchIndex: b.input.batchIndex,
        withdrawalIndex: w.index,
        recipient: w.recipient,
        denom: "uqor",
        amount: w.amount,
        proof: qledgerWithdrawalProof(ctx.chainId, ctx.rollupId, ws, i),
      });
      console.log(`Withdrawal #${w.index}: ${uqorToQor(w.amount.toString())} QOR → ${w.recipient}: ${res.transactionHash} (code ${res.code})`);
      if (res.code === 0) claimed[String(w.index)] = res.transactionHash;
    }
  }
  writeFile("state/claims.json", JSON.stringify(claimed, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
