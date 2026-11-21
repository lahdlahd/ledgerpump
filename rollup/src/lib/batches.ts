import type { BatchView, RdkClient } from "@qorechain/rdk";
import { ROLLUP_ID } from "../client.js";

/**
 * Every batch the rollup ever had, including rejected ones. The chain's list
 * query omits rejected batches, so we walk indices with the single-batch query
 * until one is missing.
 */
export async function allBatches(client: RdkClient): Promise<BatchView[]> {
  const out: BatchView[] = [];
  for (let i = 0; i < 10_000; i++) {
    try {
      out.push(await client.rest.getBatch(ROLLUP_ID, i));
    } catch {
      break;
    }
  }
  return out;
}

/** Batches that count: rejected ones were rolled back and consumed nothing. */
export const liveBatches = (bs: BatchView[]) => bs.filter((b) => b.status !== "rejected");
