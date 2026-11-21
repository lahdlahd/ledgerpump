// Business-layer checks that need only public metadata (stationId, date), so the
// public watchtower can run them without decrypting anything.

export interface ReportMeta {
  stationId: string;
  date: string;
}

export interface MonitorAlert {
  kind: "missing_day" | "duplicate_submission";
  stationId: string;
  date: string;
  count?: number;
}

function* days(from: string, to: string) {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function monitor(reports: ReportMeta[], stationIds: string[], from: string, to: string): MonitorAlert[] {
  const counts = new Map<string, number>();
  for (const r of reports) {
    const k = `${r.stationId}|${r.date}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const alerts: MonitorAlert[] = [];
  for (const stationId of stationIds) {
    for (const date of days(from, to)) {
      const n = counts.get(`${stationId}|${date}`) ?? 0;
      if (n === 0) alerts.push({ kind: "missing_day", stationId, date });
      if (n > 1) alerts.push({ kind: "duplicate_submission", stationId, date, count: n });
    }
  }
  return alerts;
}
