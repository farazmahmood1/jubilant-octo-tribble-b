/**
 * Reads CSV as spreadsheets save it (RFC 4180): commas, double-quoted fields with `""` for a
 * quote, CRLF or LF line ends, a byte-order mark. Returns rows of raw strings, each with the
 * line number it started on, so a report can point at the line a person sees in the file.
 * Throws on an unterminated quote, the one thing that cannot be read at all.
 */
export interface CsvRow {
  line: number;
  cells: string[];
}

export const parseCsv = (text: string): CsvRow[] => {
  const input = text.replace(/^﻿/, '');
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: rowStart, cells });
      cells = [];
      cell = '';
      line++;
      rowStart = line;
    } else cell += c;
  }
  if (quoted) throw new Error(`Unterminated quote starting on line ${rowStart}`);
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowStart, cells });
  }
  return rows;
};
