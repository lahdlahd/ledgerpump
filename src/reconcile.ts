// Three-way reconciliation engine. Runs on the station's device before the report is
// encrypted, so only the resulting status (not the figures) needs to leave in the clear.

import { DEFAULT_TOLERANCES } from "./types";
import type { CheckResult, DailyReport, ReconciliationResult, Status, Tolerances } from "./types";

const round1 = (n: number) => Math.round(n * 10) / 10;

function classify(variance: number, base: number, frac: number, exactBand: number): Status {
  const abs = Math.abs(variance);
  if (abs <= exactBand) return "balanced";
  if (abs <= Math.abs(base) * frac) return "within_tolerance";
  return "discrepancy";
}

const RANK: Record<Status, number> = { balanced: 0, within_tolerance: 1, discrepancy: 2 };
export const worst = (a: Status, b: Status): Status => (RANK[a] >= RANK[b] ? a : b);

export function meteredLitres(p: DailyReport["products"][number]): number {
  return round1(p.pumps.reduce((s, x) => s + (x.closingMeter - x.openingMeter), 0));
}

export function reconcile(
  report: DailyReport,
  tol: Tolerances = DEFAULT_TOLERANCES,
): ReconciliationResult {
  const checks: CheckResult[] = [];
  let expectedRevenue = 0;
  let exposure = 0;

  for (const p of report.products) {
    for (const pump of p.pumps) {
      if (pump.closingMeter < pump.openingMeter) {
        throw new Error(`${report.stationId} ${report.date} ${pump.pumpId}: closing meter below opening`);
      }
    }
    const sold = meteredLitres(p);
    expectedRevenue += Math.round(sold * p.pricePerLitreKobo);

    // 1. Meters vs tanks: how much left the tank vs how much the pumps recorded.
    const tankOut = round1(p.openingDip + p.receivedLitres - p.closingDip);
    const v1 = round1(tankOut - sold); // positive = fuel left the tank without being metered
    const s1 = classify(v1, sold, tol.meterVsTank, tol.balancedLitres);
    checks.push({ check: "meter_vs_tank", product: p.product, expected: sold, actual: tankOut, variance: v1, unit: "litres", status: s1 });
    if (s1 === "discrepancy" && v1 > 0) exposure += Math.round(v1 * p.pricePerLitreKobo);

    // 3. Received vs waybill (only when a delivery happened).
    if (p.waybillLitres > 0 || p.receivedLitres > 0) {
      const v3 = round1(p.receivedLitres - p.waybillLitres); // negative = short delivery
      const s3 = classify(v3, p.waybillLitres, tol.receivedVsWaybill, tol.balancedLitres);
      checks.push({ check: "received_vs_waybill", product: p.product, expected: p.waybillLitres, actual: p.receivedLitres, variance: v3, unit: "litres", status: s3 });
      if (s3 === "discrepancy" && v3 < 0) exposure += Math.round(-v3 * p.pricePerLitreKobo);
    }
  }

  // 2. Litres vs money, across the whole station-day (payments aren't split by product).
  const { cashKobo, posKobo, transferKobo } = report.payments;
  const collected = cashKobo + posKobo + transferKobo;
  const v2 = collected - expectedRevenue; // negative = money short
  const s2 = classify(v2, expectedRevenue, tol.money, tol.balancedKobo);
  checks.push({ check: "money", expected: expectedRevenue, actual: collected, variance: v2, unit: "kobo", status: s2 });
  if (s2 === "discrepancy" && v2 < 0) exposure += -v2;

  const status = checks.reduce<Status>((acc, c) => worst(acc, c.status), "balanced");
  return { stationId: report.stationId, date: report.date, status, checks, exposureKobo: exposure };
}

/** A station-day qualifies for a payout only if it reconciled. */
export const qualifiesForPayout = (r: ReconciliationResult) => r.status !== "discrepancy";
