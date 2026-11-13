/** @typedef {string | number | boolean | null | undefined} CsvValue */

/** Nulls become empty cells, which is how the tiles and exports encode missing values. */
export function csvCell(/** @type {CsvValue} */ value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** @param {readonly CsvValue[]} values */
export function csvLine(values) {
  return `${values.map(csvCell).join(",")}\n`;
}

/**
 * @param {readonly string[]} columns
 * @param {Iterable<Record<string, CsvValue>>} rows
 */
export function csvTable(columns, rows) {
  let text = csvLine(columns);
  for (const row of rows) text += csvLine(columns.map((column) => row[column]));
  return text;
}
