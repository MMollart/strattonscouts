/** Parse a pounds amount typed by an admin ("12", "12.5", "£12.50") into pence, or null. */
export function poundsToPence(input: string): number | null {
  const cleaned = input.replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Pence as an editable pounds string, e.g. 1050 -> "10.50". */
export function penceToPounds(pence: number): string {
  return (pence / 100).toFixed(2);
}
