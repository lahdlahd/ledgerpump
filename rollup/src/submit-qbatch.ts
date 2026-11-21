import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes, planQledgerBatch, QledgerLedger } from "@qorechain/rdk";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";

// Plan and submit the next qledger-v1 batch: choose the inbox range by the
// chain's admission rules, fetch and verify the entries, execute them, and
// publish the canonical state and withdrawals roots.
//
// The ledger after each batch is kept in rollup/state/ledger.json as the
// parent state of the next one. Each plan is saved in rollup/state/batches/.

const STATE_DIR = new URL("../state/", import.meta.url);
const LEDGER_FILE = new URL("ledger.json", STATE_DIR);

type Stored = { id: string; balance: string; nonce: string }[];

function loadLedger(): QledgerLedger {
  const l = new QledgerLedger();
  if (existsSync(LEDGER_FILE)) {
    for (const a of JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Stored) {
      l.set(hexToBytes(a.id), BigInt(a.balance), BigInt(a.nonce));
    }
  }
  return l;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? bytesToHex(x) : x), 2);

async function main(): Promise<void> {
  const client = getClient();
  const tx = await connectOperator(client);
  const chainId = client.network.chainId;

  const plan = await planQledgerBatch(client.rest, {
    chainId,
    rollupId: ROLLUP_ID,
    submitter: tx.address,
    ledger: loadLedger(),
  });

  console.log(`Batch ${plan.input.batchIndex}: inbox up to ${plan.input.inboxEnd}, ${plan.entries.length} entries`);
  console.log(`  prev state root:  ${bytesToHex(plan.input.prevStateRoot)}`);
  console.log(`  state root:       ${bytesToHex(plan.input.stateRoot)}`);
  console.log(`  withdrawals root: ${bytesToHex(plan.input.withdrawalsRoot) || "(none)"}`);
  console.log(`  data hash:        ${bytesToHex(plan.input.dataHash)}`);

  const res = await tx.submitBatch(plan.input);
  console.log(`Submitted: ${res.transactionHash} (code ${res.code}) at height ${res.height}`);
  if (res.code !== 0) process.exit(1);

  mkdirSync(new URL("batches/", STATE_DIR), { recursive: true });
  writeFileSync(
    new URL(`batches/${plan.input.batchIndex}.json`, STATE_DIR),
    json({ txHash: res.transactionHash, input: plan.input, entries: plan.entries, result: plan.result }),
  );
  const stored: Stored = plan.ledger.accounts().map((a) => ({
    id: bytesToHex(a.id),
    balance: a.balance.toString(),
    nonce: a.nonce.toString(),
  }));
  writeFileSync(LEDGER_FILE, JSON.stringify(stored, null, 2));
  console.log("Saved ledger state and batch plan in rollup/state/.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
