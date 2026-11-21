import {
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  hexToBytes,
  qledgerKeypairFromSeed,
  QledgerLedger,
  type QledgerEntry,
  type RdkClient,
} from "@qorechain/rdk";
import { exists, readJson, secret } from "./files.js";
import { ROLLUP_ID } from "../client.js";

/** An L2 (qledger-v1, ML-DSA-44) account whose seed lives in rollup/keys/. */
export const l2Account = (name: string) => qledgerKeypairFromSeed(secret(`${name}.mldsa44.seed`, 32));
export const treasury = () => l2Account("treasury");
export const stationL2 = (stationId: string) => l2Account(`station-${stationId}`);

type Stored = { id: string; balance: string; nonce: string }[];

/** The ledger after the last batch this machine submitted (rollup/state/ledger.json). */
export function settledLedger(): QledgerLedger {
  const l = new QledgerLedger();
  if (exists("state/ledger.json")) {
    for (const a of readJson<Stored>("state/ledger.json")) l.set(hexToBytes(a.id), BigInt(a.balance), BigInt(a.nonce));
  }
  return l;
}

/** Every inbox entry, read back from the chain and checked against its accumulator. */
export async function allEntries(client: RdkClient): Promise<{ entries: QledgerEntry[]; consumed: number }> {
  const inbox = await client.rest.getInbox(ROLLUP_ID);
  const entries = await fetchQledgerEntries(client.rest, {
    chainId: client.network.chainId,
    rollupId: ROLLUP_ID,
    from: 0,
    to: inbox.headSequence,
    accFrom: EMPTY_INBOX_ACC,
  });
  return { entries, consumed: inbox.consumedSequence };
}

/** The ledger as it will be once every posted (not yet batched) entry is executed. */
export async function pendingLedger(client: RdkClient): Promise<QledgerLedger> {
  const { entries, consumed } = await allEntries(client);
  const l = settledLedger();
  executeQledger({ chainId: client.network.chainId, rollupId: ROLLUP_ID }, l, entries.slice(consumed));
  return l;
}
