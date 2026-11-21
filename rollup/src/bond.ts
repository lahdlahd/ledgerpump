import "dotenv/config";
import { DEFAULT_MIN_SUBMITTER_BOND_UQOR, uqorToQor } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";

// Post the submitter bond a qledger-v1 rollup requires before this account can
// submit batches. Tops up only the difference if a bond already exists.
async function main(): Promise<void> {
  const client = getClient();
  const tx = await connectOperator(client);
  const params = await client.params();
  const min = BigInt(params.minSubmitterBond ?? DEFAULT_MIN_SUBMITTER_BOND_UQOR);

  let have = 0n;
  try {
    have = BigInt((await client.rest.getSubmitterBond(ROLLUP_ID, tx.address)).amount);
  } catch {
    /* no bond yet */
  }
  console.log(`Submitter ${tx.address} on "${ROLLUP_ID}"`);
  console.log(`Required bond: ${uqorToQor(min.toString())} QOR, current: ${uqorToQor(have.toString())} QOR`);
  if (have >= min) {
    console.log("Bond already sufficient. Nothing to do.");
    return;
  }
  const res = await tx.bondRollupSubmitter({ rollupId: ROLLUP_ID, amount: min - have });
  console.log(`Bonded: ${res.transactionHash} (code ${res.code})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
