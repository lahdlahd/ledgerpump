import "dotenv/config";
import { decryptReport, sha256Hex } from "../../src/crypto.js";
import { reconcile } from "../../src/reconcile.js";
import { getClient, ROLLUP_ID } from "./client.js";
import { getSigner } from "./signer.js";
import { readdirSync } from "node:fs";
import { here, readBytes, secret } from "./lib/files.js";

// The owner's view: decrypt a stored report with the owner's ML-KEM-1024 key
// and re-run the reconciliation.
// Usage: npm run read-report -- <stationId> <date>
async function main(): Promise<void> {
  const [stationId, date] = process.argv.slice(2);
  if (!stationId || !date) throw new Error("Usage: npm run read-report -- <stationId> <YYYY-MM-DD>");
  const client = getClient();
  const [{ address }] = await (await getSigner()).getAccounts();
  // The latest stored submission for that station-day (content-addressed files).
  const files = readdirSync(here(`store/${stationId}/${date}`)).filter((f) => f.endsWith(".bin"));
  if (!files.length) throw new Error(`No stored report for ${stationId} ${date}`);
  const envelope = readBytes(`store/${stationId}/${date}/${files[files.length - 1]}`);
  const report = decryptReport(
    { chainId: client.network.chainId, rollupId: ROLLUP_ID },
    envelope,
    address,
    secret("owner.mlkem1024.seed", 64),
  );
  const r = reconcile(report);
  console.log(`Decrypted ${stationId} ${date} (ciphertext SHA-256 ${sha256Hex(envelope)})`);
  for (const c of r.checks) {
    const unit = c.unit === "kobo" ? "₦" : "L";
    const fmt = (n: number) => (c.unit === "kobo" ? (n / 100).toLocaleString("en-NG") : n.toLocaleString("en-NG"));
    console.log(`  ${c.check.padEnd(20)} ${(c.product ?? "all").padEnd(4)} expected ${fmt(c.expected)}${unit}, actual ${fmt(c.actual)}${unit}, variance ${fmt(c.variance)}${unit} → ${c.status}`);
  }
  console.log(`Status: ${r.status}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
