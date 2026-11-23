// Read a station's signed v3 report leaf back from the LedgerPump rollup inbox on chain.
// Entries are checked against the chain's inbox accumulator (fetchQledgerEntries), and the
// leaf's ML-DSA-87 signature against the station key in rollup/registry/stations.json.
import { readFileSync } from "node:fs";
import { hexToBytes } from "viem";
import { getClient, ROLLUP_ID } from "../../../rollup/src/client.ts";
import { allEntries } from "../../../rollup/src/lib/l2.ts";
import { decodePost, verifyLeaf, type ReportLeaf } from "../../../src/crypto.ts";
import { here } from "./chain.mts";

export interface ChainLeaf {
  leaf: ReportLeaf;
  signature: Uint8Array;
  sequence: number;
  poster: string;
  stationPubkey: Uint8Array;
}

export async function findLeaf(stationId: string, date: string): Promise<ChainLeaf> {
  const registry = JSON.parse(readFileSync(here("../rollup/registry/stations.json"), "utf8")) as Record<string, { mldsa87PublicKey: string }>;
  const pk = registry[stationId]?.mldsa87PublicKey;
  if (!pk) throw new Error(`${stationId} is not in rollup/registry/stations.json`);
  const stationPubkey = hexToBytes(`0x${pk}`);

  const client = getClient();
  const ctx = { chainId: client.network.chainId, rollupId: ROLLUP_ID };
  const { entries } = await allEntries(client);
  let found: ChainLeaf | undefined;
  entries.forEach((e, i) => {
    const d = decodePost(e.payload);
    if (!d || d.leaf.v !== 3 || d.leaf.stationId !== stationId || d.leaf.date !== date) return;
    if (!verifyLeaf(ctx, d.leaf, d.signature, stationPubkey)) return;
    found = { leaf: d.leaf, signature: d.signature, sequence: i + 1, poster: e.poster, stationPubkey };
  });
  if (!found) throw new Error(`No signed v3 leaf for ${stationId} ${date} in the rollup inbox. Post it first: npm run post-report -- <index> (from rollup/)`);
  return found;
}
