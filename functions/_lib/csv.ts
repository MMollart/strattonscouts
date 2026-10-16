/**
 * CSV for spreadsheets (Release 3 exports). Excel-friendly: a UTF-8 byte order
 * mark so £ and accents survive, CRLF line endings, and every field quoted.
 * A field starting with = + - @ (or a tab/CR) is prefixed with ' so a
 * spreadsheet never runs it as a formula; numbers are written as numbers.
 */

export type CsvValue = string | number | boolean | null | undefined;

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });
}

/** Pence as pounds with two decimals, as a number a spreadsheet can sum. */
export function pounds(pence: number): number {
  return Math.round(pence) / 100;
}
