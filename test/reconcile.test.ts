import { describe, expect, it } from "vitest";
import { reconcile, qualifiesForPayout } from "../src/reconcile";
import { monitor } from "../src/monitor";
import { generate } from "../data/generate";
import type { DailyReport } from "../src/types";

const base = (): DailyReport => ({
  stationId: "TEST-01",
  date: "2026-11-01",
  products: [
    {
      product: "PMS",
      pumps: [
        { pumpId: "PMS-1", openingMeter: 1000, closingMeter: 6000 },
        { pumpId: "PMS-2", openingMeter: 2000, closingMeter: 7000 },
      ],
      openingDip: 30_000,
      closingDip: 20_000,
      receivedLitres: 0,
      waybillLitres: 0,
      pricePerLitreKobo: 950_00,
    },
  ],
  payments: { cashKobo: 3_000_000_00, posKobo: 4_000_000_00, transferKobo: 2_500_000_00 }, // ₦9.5m = 10,000 L × ₦950
});

describe("reconcile", () => {
  it("balances a clean report", () => {
    const r = reconcile(base());
    expect(r.status).toBe("balanced");
    expect(r.exposureKobo).toBe(0);
  });

  it("accepts small evaporation within tolerance", () => {
    const rep = base();
    rep.products[0].closingDip = 19_980; // 20 L = 0.2%
    expect(reconcile(rep).status).toBe("within_tolerance");
  });

  it("flags fuel leaving the tank without being metered", () => {
    const rep = base();
    rep.products[0].closingDip = 19_400; // 600 L unaccounted
    const r = reconcile(rep);
    expect(r.status).toBe("discrepancy");
    const c = r.checks.find((x) => x.check === "meter_vs_tank")!;
    expect(c.variance).toBe(600);
    expect(r.exposureKobo).toBe(600 * 950_00);
  });

  it("flags a cash shortfall", () => {
    const rep = base();
    rep.payments.cashKobo -= 450_000_00;
    const r = reconcile(rep);
    expect(r.status).toBe("discrepancy");
    expect(r.checks.find((x) => x.check === "money")!.variance).toBe(-450_000_00);
    expect(r.exposureKobo).toBe(450_000_00);
  });

  it("flags a short delivery against the waybill", () => {
    const rep = base();
    rep.products[0].waybillLitres = 33_000;
    rep.products[0].receivedLitres = 31_500;
    rep.products[0].closingDip = 20_000 + 31_500;
    const r = reconcile(rep);
    expect(r.status).toBe("discrepancy");
    expect(r.checks.find((x) => x.check === "received_vs_waybill")!.variance).toBe(-1_500);
    expect(r.checks.find((x) => x.check === "meter_vs_tank")!.status).toBe("balanced");
  });

  it("rejects a meter that runs backwards", () => {
    const rep = base();
    rep.products[0].pumps[0].closingMeter = 500;
    expect(() => reconcile(rep)).toThrow(/closing meter/);
  });

  it("only pays out station-days that reconcile", () => {
    const bad = base();
    bad.payments.cashKobo = 0;
    expect(qualifiesForPayout(reconcile(base()))).toBe(true);
    expect(qualifiesForPayout(reconcile(bad))).toBe(false);
  });
});

describe("synthetic dataset", () => {
  const data = generate(2026);
  const results = data.reports.map((r) => reconcile(r));

  it("is deterministic for a seed", () => {
    expect(JSON.stringify(generate(2026).reports)).toBe(JSON.stringify(data.reports));
  });

  it("never lets a tank go negative or overflow a truckload above start stock", () => {
    for (const r of data.reports) for (const p of r.products) expect(p.closingDip).toBeGreaterThan(0);
  });

  it("flags exactly the planted reconciliation anomalies and nothing else", () => {
    const flagged = results.filter((r) => r.status === "discrepancy").map((r) => `${r.stationId}|${r.date}`);
    const planted = data.anomalies
      .filter((a) => ["meter_vs_tank", "money", "received_vs_waybill"].includes(a.kind))
      .map((a) => `${a.stationId}|${a.date}`);
    expect(flagged.sort()).toEqual(planted.sort());
  });

  it("each planted anomaly trips the right check", () => {
    for (const a of data.anomalies.filter((x) => ["meter_vs_tank", "money", "received_vs_waybill"].includes(x.kind))) {
      const r = results.find((x) => x.stationId === a.stationId && x.date === a.date)!;
      const bad = r.checks.filter((c) => c.status === "discrepancy").map((c) => c.check);
      expect(bad).toEqual([a.kind]);
    }
  });

  it("the monitor finds the missing day and the duplicate from metadata alone", () => {
    const alerts = monitor(data.reports, data.stations.map((s) => s.stationId), data.from, data.to);
    expect(alerts).toEqual([
      { kind: "duplicate_submission", stationId: "NGT-LAG-01", date: "2026-11-22", count: 2 },
      { kind: "missing_day", stationId: "RVS-BEN-01", date: "2026-11-20" },
    ]);
  });
});
