import "dotenv/config";
import {
  bytesToHex,
  executeQledger,
  hexToBytes,
  QledgerLedger,
  uqorToQor,
} from "@qorechain/rdk";
import { decodePost, decryptReport } from "../../src/crypto.js";
import { reconcile } from "../../src/reconcile.js";
import { watch } from "../../src/watchtower.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { exists, readBytes, readJson, secret, writeFile } from "./lib/files.js";
import { allEntries, stationL2, treasury } from "./lib/l2.js";

// Build the dashboard's data from the chain.
//   dashboard/data/public.json  everything the public watchtower can see (safe to commit)
//   dashboard/data/owner.json   decrypted reconciliation detail, written only on a machine
//                               holding the owner's ML-KEM-1024 key (git-ignored)
// Usage: npm run snapshot

const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();

async function main(): Promise<void> {
  const client = getClient();
  const chainId = client.network.chainId;
  const ctx = { chainId, rollupId: ROLLUP_ID };
  const rollup = await client.rest.getRollup(ROLLUP_ID);
  const inbox = await client.rest.getInbox(ROLLUP_ID);
  const { entries } = await allEntries(client);

  const registry = readJson<Record<string, { name: string; city: string; mldsa87PublicKey: string; fingerprint: string }>>(
    "registry/stations.json",
  );
  const load = (s: string, d: string, h: string) =>
    exists(`store/${s}/${d}/${h}.bin`) ? readBytes(`store/${s}/${d}/${h}.bin`) : undefined;
  const findings = watch({
    ctx,
    operator: rollup.creator,
    posts: entries.map((e, i) => ({ sequence: i + 1, poster: e.poster, payload: e.payload })),
    stationKeys: Object.fromEntries(Object.entries(registry).map(([id, r]) => [id, hexToBytes(r.mldsa87PublicKey)])),
    loadCiphertext: load,
  });

  // Batches, re-executed for canonical roots, and balances after each.
  const batches = (await client.rest.listBatches(ROLLUP_ID)).sort((a, b) => a.batchIndex - b.batchIndex);
  const ledger = new QledgerLedger();
  const batchRows = batches.map((b) => {
    const r = executeQledger(ctx, ledger, entries.slice(b.inboxStart, b.inboxEnd));
    return {
      index: b.batchIndex,
      status: b.status,
      inboxStart: b.inboxStart,
      inboxEnd: b.inboxEnd,
      submittedAt: b.submittedAt,
      stateRoot: norm(b.stateRoot),
      withdrawalsRoot: norm(b.withdrawalsRoot ?? ""),
      canonical: norm(b.stateRoot) === norm(bytesToHex(r.stateRoot)) && norm(b.withdrawalsRoot ?? "") === norm(bytesToHex(r.withdrawalsRoot)),
      withdrawals: r.withdrawals.map((w) => ({ index: Number(w.index), recipient: w.recipient, qor: uqorToQor(w.amount.toString()) })),
    };
  });

  // Inbox entries classified for the timeline.
  const kinds = entries.map((e, i) => {
    const seq = i + 1;
    const magic = new TextDecoder().decode(e.payload.subarray(0, 4));
    if (e.poster.startsWith("deposit:")) return { seq, kind: "deposit" };
    if (magic === "LPS1") return { seq, kind: "station_key" };
    if (magic === "LPR2") return { seq, kind: "report", leaf: decodePost(e.payload)?.leaf };
    if (magic === "LPR1") return { seq, kind: "report_v1_test" };
    return { seq, kind: "ledger_tx" };
  });

  const payouts: Record<string, string> = exists("state/payouts.json") ? readJson("state/payouts.json") : {};
  const claims: Record<string, string> = exists("state/claims.json") ? readJson("state/claims.json") : {};

  const stations = Object.entries(registry).map(([id, r]) => ({
    stationId: id,
    name: r.name,
    city: r.city,
    keyFingerprint: r.fingerprint,
    anchored: findings.some((f) => f.kind === "station_anchored" && f.stationId === id),
    reports: findings.filter((f) => f.stationId === id && (f.kind === "ok" || f.kind === "discrepancy_reported")).length,
    paidDays: Object.keys(payouts).filter((k) => k.startsWith(id + "|")).length,
    l2BalanceQor: uqorToQor(ledger.get(stationL2(id).accountId).balance.toString()),
  }));

  const pub = {
    generatedAt: new Date().toISOString(),
    chainId,
    rollup: { id: ROLLUP_ID, status: rollup.status, profile: rollup.profile, settlement: rollup.settlementMode, creator: rollup.creator },
    inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence },
    treasuryQor: uqorToQor(ledger.get(treasury().accountId).balance.toString()),
    stations,
    findings,
    entries: kinds,
    batches: batchRows,
    payouts,
    claims,
  };
  writeFile("../dashboard/data/public.json", JSON.stringify(pub, null, 2));
  console.log(`Public snapshot: ${findings.length} findings, ${batchRows.length} batches → dashboard/data/public.json`);

  // Owner view: decrypt what this machine's owner key can open.
  if (exists("keys/owner.mlkem1024.seed")) {
    const ownerSeed = secret("owner.mlkem1024.seed", 64);
    const owner: unknown[] = [];
    for (const f of findings.filter((x) => x.kind === "ok" || x.kind === "discrepancy_reported")) {
      const leaf = (kinds[f.sequence - 1] as { leaf?: { ciphertextHash: string } }).leaf;
      const ct = leaf && load(f.stationId!, f.date!, leaf.ciphertextHash);
      if (!ct) continue;
      const r = reconcile(decryptReport(ctx, ct, rollup.creator, ownerSeed));
      owner.push({ sequence: f.sequence, stationId: f.stationId, date: f.date, status: r.status, exposureKobo: r.exposureKobo, checks: r.checks });
    }
    writeFile("../dashboard/data/owner.json", JSON.stringify(owner, null, 2));
    console.log(`Owner view: ${owner.length} reports decrypted → dashboard/data/owner.json (git-ignored)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
