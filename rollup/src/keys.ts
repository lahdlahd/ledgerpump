import "dotenv/config";
import { kemKeypairFromSeed } from "@qorechain/rdk";
import { publicKeyFingerprint, stationKeypair } from "../../src/crypto.js";
import { readJson, secret, writeFile } from "./lib/files.js";

// Generate LedgerPump's keys on this machine (once; re-running reuses them).
//
// Secrets go to rollup/keys/ (git-ignored, never commit or share them):
//   keys/station-<id>.mldsa87.seed   32-byte ML-DSA-87 seed per station
//   keys/owner.mlkem1024.seed        64-byte ML-KEM-1024 seed for the owner (reader)
// Public keys go to rollup/registry/ (safe to commit):
//   registry/stations.json           each station's ML-DSA-87 public key + fingerprint

type Station = { stationId: string; name: string; city: string };

const stations = readJson<Station[]>("../data/sample/stations.json");
const registry: Record<string, { name: string; city: string; mldsa87PublicKey: string; fingerprint: string }> = {};
for (const s of stations) {
  const kp = stationKeypair(secret(`station-${s.stationId}.mldsa87.seed`, 32));
  registry[s.stationId] = {
    name: s.name,
    city: s.city,
    mldsa87PublicKey: Buffer.from(kp.publicKey).toString("hex"),
    fingerprint: publicKeyFingerprint(kp.publicKey),
  };
  console.log(`Station ${s.stationId}: ML-DSA-87 key ${registry[s.stationId].fingerprint.slice(0, 16)}…`);
}
writeFile("registry/stations.json", JSON.stringify(registry, null, 2));

const owner = kemKeypairFromSeed(secret("owner.mlkem1024.seed", 64));
console.log(`Owner ML-KEM-1024 key: ${owner.publicKey.length} bytes (register it with: npm run register-kem)`);
console.log("Secrets are in rollup/keys/ (git-ignored). Public registry written to rollup/registry/stations.json.");
