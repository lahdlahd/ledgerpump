// Read-only probe of QoreChain's PQC precompile (0x0A01 pqcVerify, 0x0A02 pqcKeyStatus).
// No transactions, no gas spent. Run from evm/: npm run pqc-probe
import { createPublicClient, http, bytesToHex, encodeFunctionData, type Hex } from "viem";
import { ml_dsa44, ml_dsa65, ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { IQORE_PQC_ABI, qorechainTestnet } from "@qorechain/evm";
import { EVM_RPC, evmIdentity } from "./lib/chain.mts";

const client = createPublicClient({ chain: qorechainTestnet, transport: http(EVM_RPC) });
const VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const STATUS = "0x0000000000000000000000000000000000000a02" as const;

async function verify(label: string, pk: Uint8Array, sig: Uint8Array, msg: Uint8Array) {
  const args = [bytesToHex(pk), bytesToHex(sig), bytesToHex(msg)] as const;
  try {
    const valid = await client.readContract({ address: VERIFY, abi: IQORE_PQC_ABI, functionName: "pqcVerify", args });
    let gas = "?";
    try {
      gas = (await client.estimateGas({ to: VERIFY, data: encodeFunctionData({ abi: IQORE_PQC_ABI, functionName: "pqcVerify", args }) })).toString();
    } catch { /* estimate optional */ }
    console.log(`${label.padEnd(44)} -> ${valid}   (gas est ${gas})`);
  } catch (e) {
    console.log(`${label.padEnd(44)} -> ERROR ${(e as Error).message.split("\n")[0]}`);
  }
}

async function main() {
  const msg = new TextEncoder().encode("ledgerpump/claim/v1|probe");
  const other = new TextEncoder().encode("ledgerpump/claim/v1|other");
  const seed = new Uint8Array(32).fill(7); // fixed, throwaway: probe only

  for (const [name, alg] of [["ML-DSA-87", ml_dsa87], ["ML-DSA-65", ml_dsa65], ["ML-DSA-44", ml_dsa44]] as const) {
    const { publicKey, secretKey } = alg.keygen(seed);
    const sig = alg.sign(msg, secretKey);
    const bad = sig.slice(); bad[10] ^= 1;
    console.log(`\n${name}: pubkey ${publicKey.length} B, signature ${sig.length} B`);
    await verify(`${name} valid signature`, publicKey, sig, msg);
    await verify(`${name} tampered signature`, publicKey, bad, msg);
    await verify(`${name} signature over a different message`, publicKey, sig, other);
  }

  const address = (await evmIdentity()).evm;
  try {
    const [registered, algorithmId, pubkey] = await client.readContract({
      address: STATUS, abi: IQORE_PQC_ABI, functionName: "pqcKeyStatus", args: [address],
    }) as readonly [boolean, number, Hex];
    console.log(`\npqcKeyStatus(${address}): registered=${registered} algorithmId=${algorithmId} pubkey=${(pubkey.length - 2) / 2} B`);
  } catch (e) {
    console.log(`\npqcKeyStatus ERROR ${(e as Error).message.split("\n")[0]}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
