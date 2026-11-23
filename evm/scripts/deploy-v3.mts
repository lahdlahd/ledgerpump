// Deploy PayoutGateV3 on QoreChain testnet: a payout needs the station's signed v3 rollup leaf
// (rebuilt on-chain, ML-DSA-87 checked by the pqcVerify precompile 0x0A01) AND a ZK proof over
// the exact commitment in that leaf.
// Reuses the ReconcileVerifier and the station payees from the first deployment.
// Usage (from evm/): npm run compile && npm run deploy-v3
import { readFileSync } from "node:fs";
import { parseEther, sha256, type Hex } from "viem";
import { evmIdentity, ensurePqc, openWindow, windowStatus, readJson, writeJson, exists, here } from "./lib/chain.mts";

const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
const artifact = (name: string) => JSON.parse(readFileSync(here(`artifacts/contracts/${name}.sol/${name}.json`), "utf8")) as { abi: any; bytecode: Hex };

async function main() {
  if (exists("deployment-v3.json")) throw new Error("evm/deployment-v3.json exists: already deployed.");
  const v1 = readJson<{ verifier: Hex; payees: Record<string, Hex> }>("deployment.json");
  const registry = JSON.parse(readFileSync(here("../rollup/registry/stations.json"), "utf8")) as Record<string, { mldsa87PublicKey: string }>;

  const id = await evmIdentity();
  console.log(`EVM identity: ${id.evm}`);
  await ensurePqc(id);

  let w = await windowStatus(id.cosmos);
  if (!w.live || w.remainingTxs < 8n || w.remainingValue < 3_000_000n) {
    const tx = await openWindow(id, { blocks: 2400, maxTxs: 15, maxValueUqor: 5_000_000n });
    console.log(`EVM window opened (2,400 blocks, 15 txs, 5 QOR): ${tx}`);
    for (let i = 0; i < 20 && !(w = await windowStatus(id.cosmos)).live; i++) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`Window: live=${w.live}, ${w.remainingTxs} txs, ${Number(w.remainingValue) / 1e6} QOR, ${w.remainingBlocks} blocks left`);

  const g = artifact("PayoutGateV3");
  const gHash = await id.walletClient.deployContract({ abi: g.abi, bytecode: g.bytecode, args: [v1.verifier, PQC_VERIFY, parseEther("0.1"), "qorechain-diana", "ledgerpump"], value: parseEther("1"), account: id.account, chain: undefined } as any);
  const gRc = await id.publicClient.waitForTransactionReceipt({ hash: gHash });
  if (gRc.status !== "success") throw new Error(`Deploy failed: ${gHash}`);
  const gate = gRc.contractAddress!;
  console.log(`PayoutGateV3: ${gate}  (tx ${gHash}, gas ${gRc.gasUsed}), funded with 1 QOR`);
  console.log(`  verifier ${v1.verifier} (reused) · pqcVerify ${PQC_VERIFY}`);

  const registerTxs: Record<string, string> = {};
  const fingerprints: Record<string, string> = {};
  for (const [stationId, payee] of Object.entries(v1.payees)) {
    const pk = registry[stationId]?.mldsa87PublicKey;
    if (!pk) throw new Error(`No ML-DSA-87 key for ${stationId} in rollup/registry/stations.json`);
    const fp = sha256(`0x${pk}`);
    const h = await id.walletClient.writeContract({ address: gate, abi: g.abi, functionName: "registerStation", args: [stationId, payee, fp], account: id.account, chain: undefined } as any);
    await id.publicClient.waitForTransactionReceipt({ hash: h });
    registerTxs[stationId] = h;
    fingerprints[stationId] = fp;
    console.log(`  ${stationId} → payee ${payee}, key sha256 ${fp.slice(0, 18)}…  (tx ${h})`);
  }

  writeJson("deployment-v3.json", {
    chainId: 9800,
    deployer: id.evm,
    verifier: v1.verifier,
    pqcVerify: PQC_VERIFY,
    signedFor: { chainId: "qorechain-diana", rollupId: "ledgerpump" },
    gate,
    gateTx: gHash,
    payoutQor: "0.1",
    fundedQor: "1",
    payees: v1.payees,
    keyFingerprints: fingerprints,
    registerTxs,
    deployedAt: new Date().toISOString(),
  });
  console.log("\nSaved evm/deployment-v3.json. Next: npm run claim-v3 -- HLT-AKR-01 2026-11-03");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
