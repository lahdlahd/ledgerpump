// Turn a LedgerPump daily report into a Groth16 proof of reconciliation.
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
// @ts-ignore: snarkjs ships no types
import * as snarkjs from "snarkjs";
import type { DailyReport, Product } from "../../src/types";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PRODUCTS: Product[] = ["PMS", "AGO", "DPK"];
const PUMPS = 4;
const here = (p: string) => fileURLToPath(new URL(`../build/${p}`, import.meta.url));
export const WASM = here("reconcile_js/reconcile.wasm");
export const ZKEY = here("reconcile.zkey");
export const VKEY = here("verification_key.json");

const L = (litres: number) => BigInt(Math.round(litres * 10)); // litres x10

/** Public station-day id: SHA-256("ledgerpump/leaf|station|date") reduced into the field. */
export function leafId(stationId: string, date: string): bigint {
  return BigInt("0x" + createHash("sha256").update(`ledgerpump/leaf|${stationId}|${date}`).digest("hex")) % FIELD;
}

export function circuitInput(report: DailyReport, salt: bigint) {
  const openMeter: string[][] = [], closeMeter: string[][] = [];
  const openDip: string[] = [], closeDip: string[] = [], received: string[] = [], waybill: string[] = [], price: string[] = [];
  for (const prod of PRODUCTS) {
    const p = report.products.find((x) => x.product === prod);
    if (p && p.pumps.length > PUMPS) throw new Error(`${prod}: at most ${PUMPS} pumps`);
    const pumps = p?.pumps ?? [];
    openMeter.push(Array.from({ length: PUMPS }, (_, i) => String(pumps[i] ? L(pumps[i].openingMeter) : 0n)));
    closeMeter.push(Array.from({ length: PUMPS }, (_, i) => String(pumps[i] ? L(pumps[i].closingMeter) : 0n)));
    openDip.push(String(p ? L(p.openingDip) : 0n));
    closeDip.push(String(p ? L(p.closingDip) : 0n));
    received.push(String(p ? L(p.receivedLitres) : 0n));
    waybill.push(String(p ? L(p.waybillLitres) : 0n));
    price.push(String(p ? BigInt(p.pricePerLitreKobo) : 0n));
  }
  return {
    openMeter, closeMeter, openDip, closeDip, received, waybill, price,
    cash: String(report.payments.cashKobo),
    pos: String(report.payments.posKobo),
    transfer: String(report.payments.transferKobo),
    salt: String(salt),
    leafId: String(leafId(report.stationId, report.date)),
  };
}

export const newSalt = () => BigInt("0x" + randomBytes(31).toString("hex"));

export interface ReconProof {
  leafId: string;
  commitment: string;
  reconciled: boolean;
  /** Public signals in circuit order: [commitment, reconciled, leafId]. */
  publicSignals: string[];
  proof: unknown;
  salt: string;
}

export async function proveReport(report: DailyReport, salt = newSalt()): Promise<ReconProof> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput(report, salt), WASM, ZKEY);
  return {
    commitment: publicSignals[0],
    reconciled: publicSignals[1] === "1",
    leafId: publicSignals[2],
    publicSignals,
    proof,
    salt: String(salt),
  };
}

export async function verifyProof(p: Pick<ReconProof, "proof" | "publicSignals">, vkey: unknown): Promise<boolean> {
  return snarkjs.groth16.verify(vkey, p.publicSignals, p.proof);
}

/** Calldata for the Solidity verifier: [a, b, c, publicSignals]. */
export async function solidityCalldata(p: Pick<ReconProof, "proof" | "publicSignals">) {
  const raw: string = await snarkjs.groth16.exportSolidityCallData(p.proof, p.publicSignals);
  return JSON.parse(`[${raw}]`) as [string[], string[][], string[], string[]];
}
