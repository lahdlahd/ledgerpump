import "dotenv/config";
import { encodeQledgerTx, hexToBytes, qorToUqor, signQledgerTx, uqorToQor } from "@qorechain/rdk";
import { watch } from "../../src/watchtower.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator } from "./signer.js";
import { exists, readBytes, readJson, writeFile } from "./lib/files.js";
import { allEntries, pendingLedger, stationL2, treasury } from "./lib/l2.js";

// Pay every station-day that reconciled: the treasury signs a qledger-v1
// transfer (ML-DSA-44) to the station's L2 account and posts it to the inbox.
// Eligibility comes from the public watchtower: anchored station key, valid
// ML-DSA-87 signature, ciphertext matching its commitment, status not
// "discrepancy", and first submission for that station-day.
// Usage: npm run pay -- [QOR per station-day]   (default 1)
async function main(): Promise<void> {
  const per = BigInt(qorToUqor(process.argv[2] ?? "1"));
  const client = getClient();
  const ctx = { chainId: client.network.chainId, rollupId: ROLLUP_ID };
  const tx = await connectOperator(client);
  const operator = (await client.rest.getRollup(ROLLUP_ID)).creator;

  const { entries } = await allEntries(client);
  const registry = readJson<Record<string, { mldsa87PublicKey: string }>>("registry/stations.json");
  const findings = watch({
    ctx,
    operator,
    posts: entries.map((e, i) => ({ sequence: i + 1, poster: e.poster, payload: e.payload })),
    stationKeys: Object.fromEntries(Object.entries(registry).map(([id, r]) => [id, hexToBytes(r.mldsa87PublicKey)])),
    loadCiphertext: (s, d, h) => (exists(`store/${s}/${d}/${h}.bin`) ? readBytes(`store/${s}/${d}/${h}.bin`) : undefined),
  });
  const dup = new Set(findings.filter((f) => f.kind === "duplicate_submission").map((f) => f.sequence));
  const paid: Record<string, string> = exists("state/payouts.json") ? readJson("state/payouts.json") : {};
  const eligible = findings.filter((f) => f.kind === "ok" && !dup.has(f.sequence) && !paid[`${f.stationId}|${f.date}`]);
  const skipped = findings.filter((f) => f.kind === "discrepancy_reported").length;
  console.log(`${eligible.length} station-days eligible; ${skipped} held back for discrepancies; ${Object.keys(paid).length} already paid.`);
  if (!eligible.length) return;

  const t = treasury();
  const ledger = await pendingLedger(client);
  let { balance, nonce } = ledger.get(t.accountId);
  console.log(`Treasury balance (incl. pending): ${uqorToQor(balance.toString())} QOR, nonce ${nonce}`);

  for (const f of eligible) {
    if (balance < per) {
      console.log("Treasury is out of funds. Run: npm run deposit");
      break;
    }
    const to = stationL2(f.stationId!).accountId;
    const signed = signQledgerTx({ ...ctx, secretKey: t.secretKey, publicKey: t.publicKey, nonce, amount: per, to });
    const res = await tx.postRollupData({ rollupId: ROLLUP_ID, data: encodeQledgerTx(signed) });
    console.log(`Paid ${uqorToQor(per.toString())} QOR → ${f.stationId} for ${f.date}: ${res.transactionHash} (code ${res.code})`);
    if (res.code !== 0) break;
    paid[`${f.stationId}|${f.date}`] = res.transactionHash;
    balance -= per;
    nonce += 1n;
  }
  writeFile("state/payouts.json", JSON.stringify(paid, null, 2));
  console.log("Transfers settle in the next batch: npm run submit-batch");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
