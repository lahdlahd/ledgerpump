// Deploy LedgerPump's ZK-gated settlement on QoreChain testnet's EVM.
//   1. derive the EVM identity from QORE_MNEMONIC (coin-60; same phrase, new address)
//   2. register its ML-DSA-87 key (once)
//   3. open an EVM authorisation window
//   4. deploy ReconcileVerifier and PayoutGate (funded with 1 QOR, 0.1 QOR per payout)
//   5. register a payee address for each station
// Usage (from evm/): npm run compile && npm run deploy
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseEther, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmIdentity, balanceUqor, ensurePqc, openWindow, windowStatus, writeJson, exists, here } from "./lib/chain.mts";

const artifact = (name: string) => JSON.parse(readFileSync(here(`artifacts/contracts/${name}.sol/${name}.json`), "utf8")) as { abi: any; bytecode: Hex };

function payeeKey(stationId: string): Hex {
  const p = here(`../rollup/keys/evm-payee-${stationId}.key`);
  if (!existsSync(p)) {
    mkdirSync(here("../rollup/keys"), { recursive: true });
    writeFileSync(p, "0x" + randomBytes(32).toString("hex"));
  }
  return readFileSync(p, "utf8").trim() as Hex;
}

async function main() {
  if (exists("deployment.json")) throw new Error("evm/deployment.json exists: already deployed. Delete it only if you really want a fresh deployment.");
  const id = await evmIdentity();
  console.log(`EVM identity: ${id.evm}  (native form ${id.cosmos})`);

  const bal = await balanceUqor(id.cosmos);
  console.log(`Balance: ${Number(bal) / 1e6} QOR`);
  if (bal < 5_000_000n) {
    console.log(`\nFund it first: send 10 QOR to ${id.cosmos} from QoreX (testnet), then run this again.`);
    process.exit(2);
  }

  const pqc = await ensurePqc(id);
  console.log(pqc.already ? "ML-DSA-87 key: already registered" : `ML-DSA-87 key registered: ${pqc.txHash}`);

  let w = await windowStatus(id.cosmos);
  if (!w.live || w.remainingTxs < 8n) {
    const tx = await openWindow(id, { blocks: 1200, maxTxs: 15, maxValueUqor: 8_000_000n });
    console.log(`EVM window opened (1,200 blocks, 15 txs, 8 QOR): ${tx}`);
    for (let i = 0; i < 20 && !(w = await windowStatus(id.cosmos)).live; i++) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`Window: live=${w.live}, ${w.remainingTxs} txs, ${Number(w.remainingValue) / 1e6} QOR, ${w.remainingBlocks} blocks left`);

  const v = artifact("ReconcileVerifier");
  const vHash = await id.walletClient.deployContract({ abi: v.abi, bytecode: v.bytecode, args: [], account: id.account, chain: undefined } as any);
  const vRc = await id.publicClient.waitForTransactionReceipt({ hash: vHash });
  console.log(`ReconcileVerifier: ${vRc.contractAddress}  (tx ${vHash}, gas ${vRc.gasUsed})`);

  const g = artifact("PayoutGate");
  const gHash = await id.walletClient.deployContract({ abi: g.abi, bytecode: g.bytecode, args: [vRc.contractAddress, parseEther("0.1")], value: parseEther("1"), account: id.account, chain: undefined } as any);
  const gRc = await id.publicClient.waitForTransactionReceipt({ hash: gHash });
  const gate = gRc.contractAddress!;
  console.log(`PayoutGate:        ${gate}  (tx ${gHash}, gas ${gRc.gasUsed}), funded with 1 QOR`);

  const stations = JSON.parse(readFileSync(here("../data/sample/stations.json"), "utf8")) as { stationId: string }[];
  const payees: Record<string, string> = {};
  const registerTxs: Record<string, string> = {};
  for (const s of stations) {
    const payee = privateKeyToAccount(payeeKey(s.stationId)).address;
    const h = await id.walletClient.writeContract({ address: gate, abi: g.abi, functionName: "registerStation", args: [s.stationId, payee], account: id.account, chain: undefined } as any);
    await id.publicClient.waitForTransactionReceipt({ hash: h });
    payees[s.stationId] = payee;
    registerTxs[s.stationId] = h;
    console.log(`  ${s.stationId} → payee ${payee}  (tx ${h})`);
  }

  writeJson("deployment.json", {
    chainId: 9800,
    deployer: id.evm,
    deployerNative: id.cosmos,
    verifier: vRc.contractAddress,
    verifierTx: vHash,
    gate,
    gateTx: gHash,
    payoutQor: "0.1",
    fundedQor: formatEther(parseEther("1")),
    payees,
    registerTxs,
    deployedAt: new Date().toISOString(),
  });
  console.log("\nSaved evm/deployment.json. Next: npm run claim -- NGT-LAG-01 2026-11-01");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
