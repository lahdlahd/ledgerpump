import "dotenv/config";
import { bytesToHex, kemKeypairFromSeed } from "@qorechain/rdk";
import { getClient } from "./client.js";
import { connectOperator } from "./signer.js";
import { secret } from "./lib/files.js";

// Publish the owner's ML-KEM-1024 encapsulation key in QoreChain's KEM registry,
// so stations encrypt reports to the key the chain says the owner holds.
async function main(): Promise<void> {
  const client = getClient();
  const tx = await connectOperator(client);
  const { publicKey } = kemKeypairFromSeed(secret("owner.mlkem1024.seed", 64));
  const mine = bytesToHex(publicKey).replace(/^0x/, "").toLowerCase();

  const existing = await client.rest.getKemKey(tx.address).catch(() => undefined);
  if (existing && existing.publicKey.replace(/^0x/, "").toLowerCase() === mine) {
    console.log(`Owner ${tx.address} already has this ML-KEM-1024 key registered (height ${existing.registeredHeight}).`);
    return;
  }
  if (existing) console.log("A different KEM key is registered; replacing it.");
  const res = await tx.registerKemKey({ publicKey });
  console.log(`Registered ML-KEM-1024 key for ${tx.address}: ${res.transactionHash} (code ${res.code})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
