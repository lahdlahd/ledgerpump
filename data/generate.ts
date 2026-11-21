// Seeded generator for LedgerPump's synthetic demo data. Every station, figure and
// anomaly here is fictional. Run: npx tsx data/generate.ts [seed]
//
// Prices are illustrative, not quotes of any real pump price.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DailyReport, Product, ProductReading } from "../src/types";

export interface Station {
  stationId: string;
  name: string;
  city: string;
  pumps: Record<Product, number>;
}

export const STATIONS: Station[] = [
  { stationId: "NGT-LAG-01", name: "Northgate Fuel", city: "Lagos", pumps: { PMS: 4, AGO: 2, DPK: 1 } },
  { stationId: "RVS-BEN-01", name: "Riverside Fuel", city: "Benin", pumps: { PMS: 3, AGO: 2, DPK: 1 } },
  { stationId: "HLT-AKR-01", name: "Hilltop Fuel", city: "Akure", pumps: { PMS: 3, AGO: 1, DPK: 1 } },
];

const PRICE_KOBO: Record<Product, number> = { PMS: 950_00, AGO: 1_150_00, DPK: 1_250_00 };
const DAILY_SALES: Record<Product, [number, number]> = { PMS: [8_000, 15_000], AGO: [2_000, 5_000], DPK: [500, 1_500] };
const START_DIP: Record<Product, number> = { PMS: 40_000, AGO: 30_000, DPK: 16_000 };
const REORDER_AT: Record<Product, number> = { PMS: 18_000, AGO: 9_000, DPK: 4_000 };
const TRUCK: Record<Product, number> = { PMS: 33_000, AGO: 33_000, DPK: 15_000 };

export const START_DATE = "2026-11-01";
export const DAYS = 30;

/** Planted anomalies. `day` is 1-based. */
export const ANOMALIES = [
  { kind: "meter_vs_tank", stationId: "NGT-LAG-01", day: 8, product: "PMS" as Product, litres: 600, note: "600 L left the PMS tank without passing a meter" },
  { kind: "money", stationId: "RVS-BEN-01", day: 12, kobo: 450_000_00, note: "₦450,000 cash short" },
  { kind: "received_vs_waybill", stationId: "HLT-AKR-01", day: 15, product: "PMS" as Product, litres: 1_500, note: "PMS truck delivered 31,500 L against a 33,000 L waybill" },
  { kind: "missing_day", stationId: "RVS-BEN-01", day: 20, note: "No report submitted" },
  { kind: "duplicate_submission", stationId: "NGT-LAG-01", day: 22, note: "Same report submitted twice" },
  { kind: "edited_after_submission", stationId: "HLT-AKR-01", day: 25, field: "payments.cashKobo", deltaKobo: -200_000_00, note: "Stored report altered by −₦200,000 after it was batched (applied in the watchtower demo, not here)" },
] as const;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const dateOf = (day: number) => {
  const d = new Date(`${START_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + day - 1);
  return d.toISOString().slice(0, 10);
};

export function generate(seed = 2026) {
  const rand = mulberry32(seed);
  const between = (a: number, b: number) => a + (b - a) * rand();
  const reports: DailyReport[] = [];

  for (const st of STATIONS) {
    const products = Object.keys(st.pumps) as Product[];
    const dip = Object.fromEntries(products.map((p) => [p, START_DIP[p]])) as Record<Product, number>;
    const meters = Object.fromEntries(
      products.map((p) => [p, Array.from({ length: st.pumps[p] }, () => Math.round(between(100_000, 900_000)))]),
    ) as Record<Product, number[]>;

    for (let day = 1; day <= DAYS; day++) {
      const date = dateOf(day);
      const readings: ProductReading[] = [];
      let expectedKobo = 0;

      for (const p of products) {
        const anomaly = ANOMALIES.find((a) => a.stationId === st.stationId && a.day === day && "product" in a && a.product === p);
        const openingDip = r1(dip[p]);

        // Delivery when stock is low (or forced for the short-delivery anomaly).
        let waybill = 0;
        let received = 0;
        if (openingDip < REORDER_AT[p] || anomaly?.kind === "received_vs_waybill") {
          waybill = TRUCK[p];
          received = r1(waybill * (1 - between(0, 0.001))); // normal transit loss ≤0.1%
          if (anomaly?.kind === "received_vs_waybill") received = r1(waybill - anomaly.litres);
        }

        // Sales split across pumps; meters are cumulative day to day.
        const sold = between(...DAILY_SALES[p]);
        const weights = meters[p].map(() => between(0.6, 1.4));
        const wsum = weights.reduce((a, b) => a + b, 0);
        const pumps = meters[p].map((open, i) => {
          const close = r1(open + (sold * weights[i]) / wsum);
          meters[p][i] = close;
          return { pumpId: `${p}-${i + 1}`, openingMeter: r1(open), closingMeter: close };
        });
        const metered = r1(pumps.reduce((s, x) => s + x.closingMeter - x.openingMeter, 0));

        // Tank: evaporation (≤0.2%) + dip reading noise (±0.1%), plus any planted loss.
        let out = metered * (1 + between(0, 0.002)) + metered * between(-0.001, 0.001);
        if (anomaly?.kind === "meter_vs_tank") out += anomaly.litres;
        const closingDip = r1(openingDip + received - out);
        dip[p] = closingDip;

        readings.push({ product: p, pumps, openingDip, closingDip, receivedLitres: received, waybillLitres: waybill, pricePerLitreKobo: PRICE_KOBO[p] });
        expectedKobo += Math.round(metered * PRICE_KOBO[p]);
      }

      // Payments: ±0.1% rounding noise, split cash / POS / transfer.
      let collected = Math.round(expectedKobo * (1 + between(-0.001, 0.001)));
      const cashGap = ANOMALIES.find((a) => a.stationId === st.stationId && a.day === day && a.kind === "money");
      if (cashGap && "kobo" in cashGap) collected -= cashGap.kobo;
      const cash = Math.round(collected * between(0.25, 0.35));
      const pos = Math.round(collected * between(0.35, 0.45));
      const report: DailyReport = {
        stationId: st.stationId,
        date,
        products: readings,
        payments: { cashKobo: cash, posKobo: pos, transferKobo: collected - cash - pos },
      };

      const kind = ANOMALIES.find((a) => a.stationId === st.stationId && a.day === day)?.kind;
      if (kind === "missing_day") continue; // the station simply never submits
      reports.push(report);
      if (kind === "duplicate_submission") reports.push(structuredClone(report));
    }
  }

  return {
    seed,
    from: START_DATE,
    to: dateOf(DAYS),
    stations: STATIONS,
    reports,
    anomalies: ANOMALIES.map((a) => ({ ...a, date: dateOf(a.day) })),
  };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const seed = Number(process.argv[2] ?? 2026);
  const data = generate(seed);
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "sample");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "stations.json"), JSON.stringify(data.stations, null, 2));
  writeFileSync(join(outDir, "reports.json"), JSON.stringify(data.reports, null, 2));
  writeFileSync(join(outDir, "anomalies.json"), JSON.stringify({ seed, from: data.from, to: data.to, anomalies: data.anomalies }, null, 2));
  console.log(`Wrote ${data.reports.length} reports for ${data.stations.length} stations (${data.from} → ${data.to}), seed ${seed}`);
}
