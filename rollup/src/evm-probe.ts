// Read-only probe: which precompiles does QoreChain's EVM (testnet) actually
// expose? Uses eth_call only, so it needs no key, no gas and no EVM window.
// Usage: npm run evm-probe
const RPC = process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host";

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: string; error?: { message: string } };
}
const call = (to: string, data: string) => rpc("eth_call", [{ to, data, gas: "0x2dc6c0" }, "latest"]);
const show = (label: string, res: { result?: string; error?: { message: string } }) =>
  console.log(`${label.padEnd(44)} ${res.error ? "ERROR " + res.error.message : res.result}`);

// BN254 generators (EIP-196/197 test vectors).
const g1 = "0000000000000000000000000000000000000000000000000000000000000001" + "0000000000000000000000000000000000000000000000000000000000000002";
const negG1 = "0000000000000000000000000000000000000000000000000000000000000001" + "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd45";
const g2 =
  "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2" + "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
  "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b" + "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa";

async function main() {
  show("eth_chainId", await rpc("eth_chainId", []));
  show("0x02 sha256('')", await call("0x0000000000000000000000000000000000000002", "0x"));
  show("0x06 ecAdd(G1, G1)  [expect 2*G1]", await call("0x0000000000000000000000000000000000000006", "0x" + g1 + g1));
  show("0x07 ecMul(G1, 2)   [expect 2*G1]", await call("0x0000000000000000000000000000000000000007", "0x" + g1 + "0".repeat(63) + "2"));
  show("0x08 ecPairing valid   [expect ...01]", await call("0x0000000000000000000000000000000000000008", "0x" + g1 + g2 + negG1 + g2));
  show("0x08 ecPairing invalid [expect ...00]", await call("0x0000000000000000000000000000000000000008", "0x" + g1 + g2 + g1 + g2));
  show("0x08 ecPairing gas estimate", await rpc("eth_estimateGas", [{ to: "0x0000000000000000000000000000000000000008", data: "0x" + g1 + g2 + negG1 + g2 }]));
  show("0x0a01 pqcVerify (empty input)", await call("0x0000000000000000000000000000000000000a01", "0x"));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
