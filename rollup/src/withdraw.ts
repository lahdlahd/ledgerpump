import "dotenv/config";
import { encodeQledgerTx, signQledgerTx, uqorToQor } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { pendingLedger, stationL2 } from "./lib/l2.js";

// A station withdraws its whole L2 balance to a qor1 address on the main chain.
// The withdrawal is signed by the station's ML-DSA-44 L2 key and posted to the
// inbox; once its batch finalises, anyone can execute it (npm run claim).
// Usage: npm run withdraw -- <stationId> [qor1recipient]   (default recipient: the operator)
async function main(): Promise<void> {
  const [stationId, to] = process.argv.slice(2);
  if (!stationId) throw new Error("Usage: npm run withdraw -- <stationId> [qor1recipient]");
  const client = getClient();
  const tx = await connectOperator(client);
  const recipient = to ?? tx.address;
  const s = stationL2(stationId);
  const { balance, nonce } = (await pendingLedger(client)).get(s.accountId);
  if (balance === 0n) throw new Error(`${stationId} has no L2 balance yet (pay, then submit-batch first)`);
  const signed = signQledgerTx({
    chainId: client.network.chainId,
    rollupId: ROLLUP_ID,
    secretKey: s.secretKey,
    publicKey: s.publicKey,
    nonce,
    amount: balance,
    recipient,
  });
  const res = await tx.postRollupData({ rollupId: ROLLUP_ID, data: encodeQledgerTx(signed) });
  console.log(`${stationId} withdraws ${uqorToQor(balance.toString())} QOR → ${recipient}: ${res.transactionHash} (code ${res.code})`);
  console.log("Next: npm run submit-batch, wait for it to finalise, then npm run claim");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
