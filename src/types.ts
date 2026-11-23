// LedgerPump core types. Litres are numbers rounded to 0.1 L; money is integer kobo
// (1 naira = 100 kobo) so totals never suffer floating-point drift.

export type Product = "PMS" | "AGO" | "DPK";
export const PRODUCTS: Product[] = ["PMS", "AGO", "DPK"];

export interface PumpReading {
  pumpId: string;
  openingMeter: number; // litres
  closingMeter: number; // litres
}

export interface ProductReading {
  product: Product;
  pumps: PumpReading[];
  openingDip: number; // litres in tank at open
  closingDip: number; // litres in tank at close
  receivedLitres: number; // litres actually discharged into the tank
  waybillLitres: number; // litres stated on the delivery waybill (0 if no delivery)
  pricePerLitreKobo: number;
}

export interface Payments {
  cashKobo: number;
  posKobo: number;
  transferKobo: number;
}

export interface DailyReport {
  stationId: string;
  date: string; // YYYY-MM-DD
  products: ProductReading[];
  payments: Payments;
  /** Salt for the report's ZK commitment (leaf v3). Travels only inside the encrypted report,
   *  so readers can recompute the commitment; never posted in the clear. */
  zkSalt?: string;
}

export type Status = "balanced" | "within_tolerance" | "discrepancy";

export interface Tolerances {
  /** Allowed |tank movement − metered sales| as a fraction of metered sales (evaporation, dip error). */
  meterVsTank: number;
  /** Allowed |collected − expected revenue| as a fraction of expected revenue. */
  money: number;
  /** Allowed |received − waybill| as a fraction of waybill. */
  receivedVsWaybill: number;
  /** Differences at or below these are treated as exactly balanced. */
  balancedLitres: number;
  balancedKobo: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  meterVsTank: 0.005, // 0.5%
  money: 0.002, // 0.2%
  receivedVsWaybill: 0.003, // 0.3%
  balancedLitres: 0.5,
  balancedKobo: 100_00, // ₦100
};

export interface CheckResult {
  check: "meter_vs_tank" | "money" | "received_vs_waybill";
  product?: Product;
  expected: number;
  actual: number;
  /** actual − expected. Litres for volume checks, kobo for money. */
  variance: number;
  unit: "litres" | "kobo";
  status: Status;
}

export interface ReconciliationResult {
  stationId: string;
  date: string;
  status: Status;
  checks: CheckResult[];
  /** Estimated value of all volume losses beyond tolerance plus any cash shortfall, in kobo. */
  exposureKobo: number;
}
