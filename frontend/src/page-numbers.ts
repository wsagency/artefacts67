export function parseLocalizedNumber(source: string, locale: string): number | null {
  const value = source.trim();
  if (!value) return null;

  let decimal: string, group: string | undefined;
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 1 }).formatToParts(12345.6);
    decimal = parts.find(part => part.type === "decimal")?.value ?? ".";
    group = parts.find(part => part.type === "group")?.value;
  } catch {
    return null;
  }

  const decimalParts = value.split(decimal);
  if (decimalParts.length > 2) return null;
  const whole = decimalParts[0] ?? "";
  const fraction = decimalParts.length === 2 ? decimalParts[1] : undefined;
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return null;
  if (!/^[+-]?[\d\s\u00a0\u202f.,]*$/.test(value)) return null;

  const sign = /^[+-]/.test(whole) ? whole[0] : "";
  const unsignedWhole = sign ? whole.slice(1) : whole;
  const groups = group && unsignedWhole.includes(group) ? unsignedWhole.split(group) : [unsignedWhole];
  if (groups.some(part => !/^\d+$/.test(part))) return null;
  if (groups.length > 1 && (groups[0]!.length < 1 || groups[0]!.length > 3 || groups.slice(1).some(part => part.length !== 3)))
    return null;
  const normalizedWhole = groups.join("");
  if (!normalizedWhole && fraction === undefined) return null;
  if (decimalParts.length === 2 && !normalizedWhole) return null;

  const parsed = Number(`${sign}${normalizedWhole || "0"}${fraction === undefined ? "" : `.${fraction}`}`);
  return Number.isFinite(parsed) ? parsed : null;
}
