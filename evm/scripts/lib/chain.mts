// Shared setup for LedgerPump's EVM scripts (QoreChain testnet, chain id 9800).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config } from "dotenv";
import { StargateClient } from "@cosmjs/stargate";
import { createPublicClient, createWalletClient, http, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  deriveUnifiedAccount,
  EthNativeSigner,
  fetchPqcStatus,
  buildRegisterPqcKeyMsg,
  signProofOfPossession,
  openEvmWindowMsg,
  fetchEvmWindow,
} from "@qorechain/sdk";
import { qorechainTestnet } from "@qorechain/evm";

export const here = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
config({ path: here("../rollup/.env") });

export const CHAIN_ID = "qorechain-diana";
export const REST = "https://api-testnet.qore.host";
export const RPC = "https://rpc-testnet.qore.host";
export const EVM_RPC = "https://evm-testnet.qore.host";
export const FEE = { amount: [{ denom: "uqor", amount: "80000" }], gas: "400000" };

export function readJson<T>(p: string): T { return JSON.parse(readFileSync(here(p), "utf8")) as T; }
export function writeJson(p: string, v: unknown) {
  mkdirSync(dirname(here(p)), { recursive: true });
  writeFileSync(here(p), JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}
export const exists = (p: string) => existsSync(here(p));

/**
 * The EVM identity. QoreChain EVM transactions come from an eth_secp256k1
 * (coin-60) key whose 20 bytes are also a qor1 account; that account needs its
 * own ML-DSA-87 key and an open EVM window. We derive it from the same
 * QORE_MNEMONIC as the operator, so no new secret is created.
 */
export async function evmIdentity() {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("QORE_MNEMONIC is not set in rollup/.env");
  const u = await deriveUnifiedAccount(mnemonic);
  const account = privateKeyToAccount(u.privateKey as Hex);
  const publicClient: any = createPublicClient({ chain: qorechainTestnet as never, transport: http(EVM_RPC) });
  const walletClient: any = createWalletClient({ account, chain: qorechainTestnet as never, transport: http(EVM_RPC) });
  return { u, cosmos: u.cosmos!, evm: account.address, account, publicClient, walletClient };
}

export async function balanceUqor(address: string): Promise<bigint> {
  const r = (await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`)).json()) as { balances?: { denom: string; amount: string }[] };
  return BigInt(r.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

async function accountSeq(address: string) {
  const r = (await (await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`)).json()) as { account?: Record<string, any> };
  const a = r.account?.base_account ?? r.account;
  if (!a) throw new Error(`Account ${address} not found on chain (fund it first)`);
  return { accountNumber: BigInt(a.account_number), sequence: BigInt(a.sequence ?? "0") };
}

/** Register the EVM identity's ML-DSA-87 key (once), with proof of possession. */
export async function ensurePqc(id: Awaited<ReturnType<typeof evmIdentity>>) {
  const st = await fetchPqcStatus({ rest: REST, address: id.cosmos });
  if (st.registered) return { already: true as const };
  const transport = await StargateClient.connect(RPC);
  const signer = new EthNativeSigner(id.u, { rest: REST, signMode: "classical" });
  const msg = buildRegisterPqcKeyMsg(id.cosmos, {
    pqcKeypair: id.u.pqc,
    ecdsaPubkey: hexToBytes(id.u.publicKey as Hex),
    proofOfPossession: signProofOfPossession({ chainId: CHAIN_ID, account: id.cosmos, keypair: id.u.pqc }),
  });
  const res = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, ...(await accountSeq(id.cosmos)), messages: [msg], fee: FEE });
  if (res.code !== 0) throw new Error(`PQC registration failed: code ${res.code} ${res.rawLog ?? ""}`);
  return { already: false as const, txHash: res.transactionHash };
}

/** Open (or replace) an EVM authorisation window. Unscoped windows are needed to deploy. */
export async function openWindow(id: Awaited<ReturnType<typeof evmIdentity>>, opts: { blocks: number; maxTxs: number; maxValueUqor: bigint; allowedTargets?: string[] }) {
  const transport = await StargateClient.connect(RPC);
  const signer = new EthNativeSigner(id.u, { rest: REST, signMode: "hybrid" });
  const msg = openEvmWindowMsg({
    sender: id.cosmos,
    blocks: opts.blocks,
    maxTxs: opts.maxTxs,
    maxValue: opts.maxValueUqor.toString(),
    ...(opts.allowedTargets?.length ? { allowedTargets: opts.allowedTargets } : {}),
  });
  const res = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, ...(await accountSeq(id.cosmos)), messages: [msg], fee: FEE });
  if (res.code !== 0) throw new Error(`Opening the EVM window failed: code ${res.code} ${res.rawLog ?? ""}`);
  return res.transactionHash;
}

export const windowStatus = (cosmos: string) => fetchEvmWindow({ rest: REST, address: cosmos });
