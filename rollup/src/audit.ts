import "dotenv/config";
import dotenv from "dotenv";
import { hexToBytes } from "@qorechain/rdk";
import { decryptReport, sha256Hex } from "../../src/crypto.js";
import { reconcile } from "../../src/reconcile.js";
import { watch } from "../../src/watchtower.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { getSigner } from "./signer.js";
import { exists, readBytes, readJson, secret } from "./lib/files.js";
import { allEntries } from "./lib/l2.js";
import { proveReport } from "../../zk/src/prove.js";

// Watchtower tier 2: the AUDITOR. Runs as a separate account (rollup/.env.auditor)
// holding its own ML-KEM-1024 key, never the operator's. For every report the
// public tier verified, it decrypts the ciphertext, re-runs the reconciliation,
// and checks the station's signed status against the actual figures.
// Usage: npm run audit
dotenv.config({ path: ".env.auditor", override: true });

async function main(): Promise<void> {
  const client = getClient();
  const ctx = { chainId: client.network.chainId, rollupId: ROLLUP_ID };
  const [{ address: auditor }] = await (await getSigner()).getAccounts();
  const rollup = await client.rest.getRollup(ROLLUP_ID);
  if (auditor === rollup.creator) throw new Error("rollup/.env.auditor must hold a different account from the operator");
  const seed = secret("auditor.mlkem1024.seed", 64);

  const { entries } = await allEntries(client);
  const registry = readJson<Record<string, { mldsa87PublicKey: string }>>("registry/stations.json");
  const load = (s: string, d: string, h: string) => (exists(`store/${s}/${d}/${h}.bin`) ? readBytes(`store/${s}/${d}/${h}.bin`) : undefined);
  const findings = watch({
    ctx,
    operator: rollup.creator,
    posts: entries.map((e, i) => ({ sequence: i + 1, poster: e.poster, payload: e.payload })),
    stationKeys: Object.fromEntries(Object.entries(registry).map(([id, r]) => [id, hexToBytes(r.mldsa87PublicKey)])),
    loadCiphertext: load,
  });

  console.log(`Auditor ${auditor}`);
  let audited = 0, notForMe = 0, falseStatus = 0, exposure = 0, zkChecked = 0, zkMismatch = 0;
  for (const f of findings.filter((x) => x.kind === "ok" || x.kind === "discrepancy_reported")) {
    const e = entries[f.sequence - 1];
    const leaf = JSON.parse(new TextDecoder().decode(e.payload.subarray(6, 6 + new DataView(e.payload.buffer, e.payload.byteOffset).getUint16(4))));
    const ct = load(f.stationId!, f.date!, leaf.ciphertextHash)!;
    let report;
    try {
      report = decryptReport(ctx, ct, auditor, seed);
    } catch {
      notForMe++;
      console.log(`--  #${f.sequence} ${f.stationId} ${f.date}: not encrypted to the auditor (submitted before the auditor was added)`);
      continue;
    }
    audited++;
    const r = reconcile(report);
    exposure += r.exposureKobo;
    const honest = r.status === leaf.status;
    if (!honest) falseStatus++;
    const bad = r.checks.filter((c) => c.status === "discrepancy").map((c) => `${c.check}${c.product ? ` ${c.product}` : ""} ${c.unit === "kobo" ? "₦" + (c.variance / 100).toLocaleString("en-NG") : c.variance + " L"}`);
    console.log(`${honest ? (r.status === "discrepancy" ? "!! " : "OK ") : "XX "} #${f.sequence} ${f.stationId} ${f.date}: signed "${leaf.status}", figures say "${r.status}"${bad.length ? ` [${bad.join("; ")}]` : ""} (ct ${sha256Hex(ct).slice(0, 8)}…)`);
    // Leaf v3: the signed ZK commitment must be the commitment to these decrypted figures.
    if (leaf.v === 3) {
      zkChecked++;
      const recomputed = report.zkSalt ? (await proveReport(report, BigInt(report.zkSalt))).commitment : undefined;
      const same = recomputed === leaf.zkCommitment;
      if (!same) zkMismatch++;
      console.log(`    ${same ? "OK" : "XX"} ZK commitment in the signed leaf ${same ? "matches" : "DOES NOT match"} the decrypted figures`);
    }
  }
  console.log(`\nAudited ${audited} reports (${notForMe} not addressed to the auditor). False statuses: ${falseStatus}. Exposure found: ₦${(exposure / 100).toLocaleString("en-NG")}.`);
  if (zkChecked) console.log(`ZK commitments checked against decrypted figures: ${zkChecked}, mismatches: ${zkMismatch}.`);
  process.exit(falseStatus || zkMismatch ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
