export function formatKg(value: number): string {
  return `${formatGrouped(value, 1)} kg`;
}

export function formatKsh(value: number): string {
  const negative = value < -0.004;
  const body = formatGrouped(Math.abs(value), 2);
  return negative ? `KSh -${body}` : `KSh ${body}`;
}

export function formatKshPerKg(value: number): string {
  return `${formatKsh(value)}/kg`;
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

export function describePriceGap(differencePerKg: number): string {
  const abs = formatKshPerKg(Math.abs(differencePerKg));
  if (Math.abs(differencePerKg) < 0.005) return "in line with your asking price";
  if (differencePerKg > 0) return `${abs} above your asking price`;
  return `${abs} below your asking price`;
}

function formatGrouped(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  const [whole, fraction = ""] = rounded.toFixed(decimals).split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction || /^0+$/.test(fraction)) return withCommas;
  const trimmed = fraction.replace(/0+$/, "");
  return `${withCommas}.${trimmed}`;
}
