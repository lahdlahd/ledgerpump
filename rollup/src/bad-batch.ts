import "dotenv/config";
import dotenv from "dotenv";
import { bytesToHex, DEFAULT_MIN_SUBMITTER_BOND_UQOR, planQledgerBatch, uqorToQor } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { settledLedger } from "./lib/l2.js";

// FRAUD DEMO. A second, separately bonded submitter (the "attacker", whose
// recovery phrase is in rollup/.env.attacker) submits a batch with a forged
// state root. The watchtower then proves it wrong on-chain:
//   npm run watchtower -- --challenge
// The chain re-executes the batch, rejects it, and slashes the attacker's bond
// (half burned, half to the challenger).
//
// Usage: npm run bad-batch
dotenv.config({ path: ".env.attacker", override: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const client = getClient();
  const tx = await connectOperator(client); // signs as the attacker (env overridden above)
  const rollup = await client.rest.getRollup(ROLLUP_ID);
  if (tx.address === rollup.creator) throw new Error("rollup/.env.attacker must hold a DIFFERENT account from the operator");
  console.log(`Attacker: ${tx.address}`);

  // 1. Bond (needed to submit batches at all).
  const params = await client.params();
  const min = BigInt(params.minSubmitterBond ?? DEFAULT_MIN_SUBMITTER_BOND_UQOR);
  const have = BigInt((await client.rest.getSubmitterBond(ROLLUP_ID, tx.address).catch(() => ({ amount: "0" }))).amount);
  if (have < min) {
    const r = await tx.bondRollupSubmitter({ rollupId: ROLLUP_ID, amount: min - have });
    console.log(`Bonded ${uqorToQor((min - have).toString())} QOR: ${r.transactionHash} (code ${r.code})`);
  }

  // 2. Something for the batch to consume.
  const inbox = await client.rest.getInbox(ROLLUP_ID);
  if (inbox.headSequence === inbox.consumedSequence) {
    const r = await tx.postRollupData({ rollupId: ROLLUP_ID, data: new TextEncoder().encode("LPX1 fraud-demo marker") });
    console.log(`Posted a marker entry: ${r.transactionHash} (code ${r.code}). Waiting for it to be ~20 blocks old…`);
  }

  // 3. Plan the honest batch, then forge its state root.
  let plan;
  for (let i = 0; ; i++) {
    try {
      plan = await planQledgerBatch(client.rest, { chainId: client.network.chainId, rollupId: ROLLUP_ID, submitter: tx.address, ledger: settledLedger() });
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(15_000);
    }
  }
  const honest = bytesToHex(plan.input.stateRoot);
  const forged = plan.input.stateRoot.slice();
  forged[0] ^= 0xff;
  console.log(`Batch ${plan.input.batchIndex}: honest state root ${honest}`);
  console.log(`                forged state root ${bytesToHex(forged)}`);
  const res = await tx.submitBatch({ ...plan.input, stateRoot: forged });
  console.log(`Forged batch submitted: ${res.transactionHash} (code ${res.code})`);
  console.log("Now catch it:  npm run watchtower -- --challenge");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
