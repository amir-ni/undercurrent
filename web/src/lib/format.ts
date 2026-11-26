const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf.format(n));
export const int = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf0.format(n));
export const pct = (ratio: number | null | undefined) => (ratio === null || ratio === undefined ? "—" : `${nf0.format(ratio * 100)}%`);

/** Durations read best in the largest unit that keeps a small number: 45 min, 6.5 h, 3.2 d. */
export function duration(hours: number | null | undefined): { value: string; unit: string } {
  if (hours === null || hours === undefined) return { value: "—", unit: "" };
  if (hours < 1) return { value: nf0.format(hours * 60), unit: "min" };
  if (hours < 48) return { value: nf.format(hours), unit: "h" };
  return { value: nf.format(hours / 24), unit: "d" };
}
export const durationText = (hours: number | null | undefined) => {
  const d = duration(hours);
  return d.unit ? `${d.value} ${d.unit}` : d.value;
};

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
export const date = (iso: string) => dateFmt.format(new Date(iso));
export const dayLabel = (isoDay: string) => shortDate.format(new Date(`${isoDay}T00:00:00Z`));

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Formats a fact value from the narrative's evidence chain according to its unit. */
export function factValue(value: number | string | null, unit: string): string {
  if (value === null) return "n/a";
  if (typeof value === "string") return value;
  switch (unit) {
    case "ratio":
      return value <= 1 ? pct(value) : `${num(value)}×`;
    case "hours":
      return durationText(value);
    case "days":
      return `${num(value)} d`;
    case "lines":
      return `${int(value)} lines`;
    default:
      return num(value);
  }
}
