import "dotenv/config";
import {
  bytesToHex,
  buildQledgerFraudProof,
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  hexToBytes,
  QledgerLedger,
} from "@qorechain/rdk";
import { watch } from "../../src/watchtower.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { connectOperator, getSigner } from "./signer.js";
import { exists, readBytes, readJson } from "./lib/files.js";
import { allBatches } from "./lib/batches.js";

// LedgerPump public watchtower. Holds no decryption keys.
//
// 1. Reads every inbox post back from the chain (each checked against the
//    chain's inbox accumulator) and checks station key anchors, ML-DSA-87
//    signatures, stored ciphertext hashes and duplicates.
// 2. Re-executes every batch from the inbox and compares the state and
//    withdrawals roots it published with the canonical ones. With --challenge,
//    it challenges a wrong batch on-chain with a qledger-v1 fraud proof.
//
// Usage: npm run watchtower [-- --challenge]

const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();

async function main(): Promise<void> {
  const challenge = process.argv.includes("--challenge");
  const client = getClient();
  const chainId = client.network.chainId;
  const ctx = { chainId, rollupId: ROLLUP_ID };
  const operator = (await client.rest.getRollup(ROLLUP_ID)).creator ?? (await (await getSigner()).getAccounts())[0].address;

  const inbox = await client.rest.getInbox(ROLLUP_ID);
  const entries = await fetchQledgerEntries(client.rest, { chainId, rollupId: ROLLUP_ID, from: 0, to: inbox.headSequence, accFrom: EMPTY_INBOX_ACC });
  console.log(`Inbox: ${entries.length} posts verified against the chain accumulator (head ${inbox.headSequence}, consumed ${inbox.consumedSequence})`);

  // ── 1. Report integrity ───────────────────────────────────────────────────
  const registry = readJson<Record<string, { mldsa87PublicKey: string }>>("registry/stations.json");
  const stationKeys = Object.fromEntries(Object.entries(registry).map(([id, r]) => [id, hexToBytes(r.mldsa87PublicKey)]));
  const findings = watch({
    ctx,
    operator,
    posts: entries.map((e, i) => ({ sequence: i + 1, poster: e.poster, payload: e.payload })),
    stationKeys,
    loadCiphertext: (s, d, h) => (exists(`store/${s}/${d}/${h}.bin`) ? readBytes(`store/${s}/${d}/${h}.bin`) : undefined),
  });
  const icon = { info: "OK ", warn: "!! ", alert: "XX " } as const;
  for (const f of findings) {
    console.log(`${icon[f.severity]} #${f.sequence} ${f.kind}${f.stationId ? ` ${f.stationId}` : ""}${f.date ? ` ${f.date}` : ""}${f.detail ? ` (${f.detail})` : ""}`);
  }

  // ── 2. Canonical batch check ──────────────────────────────────────────────
  const batches = await allBatches(client);
  let ledger = new QledgerLedger();
  let fraud = 0;
  for (const b of batches) {
    if (b.status === "rejected") {
      console.log(`XX  batch ${b.batchIndex} [rejected] inbox ${b.inboxStart}→${b.inboxEnd}: state root ${b.stateRoot.slice(0, 16)}… was proven wrong on-chain (fraud upheld, submitter slashed, inbox rolled back)`);
      continue;
    }
    const parent = ledger.clone();
    const slice = entries.slice(b.inboxStart, b.inboxEnd);
    const honest = executeQledger(ctx, ledger, slice);
    const okState = norm(b.stateRoot) === norm(bytesToHex(honest.stateRoot));
    const okW = norm(b.withdrawalsRoot ?? "") === norm(bytesToHex(honest.withdrawalsRoot));
    const tag = okState && okW ? "OK " : "XX ";
    console.log(`${tag} batch ${b.batchIndex} [${b.status}] inbox ${b.inboxStart}→${b.inboxEnd}: state root ${okState ? "canonical" : "WRONG"}, withdrawals root ${okW ? "canonical" : "WRONG"}`);
    if (!(okState && okW) && b.status === "submitted") {
      fraud++;
      if (challenge) {
        const accFrom = b.inboxStart === 0 ? EMPTY_INBOX_ACC : hexToBytes((await client.rest.getPostedData(ROLLUP_ID, b.inboxStart)).inboxAcc);
        const { proof } = buildQledgerFraudProof(ctx, parent, accFrom, slice);
        const tx = await connectOperator(client);
        const res = await tx.challengeBatch({ rollupId: ROLLUP_ID, batchIndex: b.batchIndex, proof });
        console.log(`    challenged: ${res.transactionHash} (code ${res.code})`);
        const after = await client.rest.getBatch(ROLLUP_ID, b.batchIndex).catch(() => undefined);
        console.log(`    batch ${b.batchIndex} is now: ${after?.status ?? "unknown"}`);
        if (after?.status === "challenged") {
          const r2 = await tx.resolveChallenge({ rollupId: ROLLUP_ID, batchIndex: b.batchIndex, fraudUpheld: true });
          console.log(`    resolved (fraud upheld): ${r2.transactionHash} (code ${r2.code})`);
        }
      }
    }
  }

  const alerts = findings.filter((f) => f.severity === "alert").length;
  const rejected = batches.filter((b) => b.status === "rejected").length;
  console.log(`\nSummary: ${findings.filter((f) => f.kind === "ok").length} reports verified, ${findings.filter((f) => f.kind === "discrepancy_reported").length} discrepancies (no payout), ${alerts} integrity alerts, ${fraud} non-canonical batches pending, ${rejected} forged batches rejected on-chain.`);
  process.exit(alerts || fraud ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
