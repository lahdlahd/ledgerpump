import "dotenv/config";
import { bytesToHex, qorToUqor } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { treasury } from "./lib/l2.js";

// Fund the payout treasury: deposit test QOR into the rollup's deposit pool,
// credited to the treasury's L2 (ML-DSA-44) account. Payouts and withdrawals
// are paid from this pool, not from the creator's stake.
// Usage: npm run deposit -- [QOR]   (default 20, minimum 1)
async function main(): Promise<void> {
  const qor = process.argv[2] ?? "20";
  const client = getClient();
  const tx = await connectOperator(client);
  const t = treasury();
  const res = await tx.depositToRollup({ rollupId: ROLLUP_ID, account: t.accountId, amount: qorToUqor(qor) });
  console.log(`Deposited ${qor} QOR to treasury L2 account ${bytesToHex(t.accountId)}`);
  console.log(`  ${res.transactionHash} (code ${res.code})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
