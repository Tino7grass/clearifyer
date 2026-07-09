'use strict';
/**
 * Clearifyer · Minimaler CSV-Parser (RFC4180-artig)
 * ---------------------------------------------------
 * Die echten ESMA-Dateien enthalten in Anführungszeichen gesetzte Felder mit
 * eingebetteten Kommas (z. B. Adressen: "Donau-City-Straße 7, 1220 Vienna,
 * Austria") und escapte Anführungszeichen (""). Ein naives split(',') würde
 * solche Zeilen falsch in zu viele Spalten zerlegen. Dieser Parser behandelt
 * Quoting korrekt, ohne eine externe Abhängigkeit zu benötigen.
 *
 * Bewusst minimal: kein Multi-Line-Field-Support (in den ESMA-Dateien nicht
 * vorhanden), kein Streaming — für Dateien dieser Größenordnung (Hunderte
 * bis wenige Tausend Zeilen) ausreichend.
 */
function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Parst einen kompletten CSV-Text mit Kopfzeile in ein Array von Objekten.
 * Entfernt ein eventuelles UTF-8 BOM am Dateianfang.
 */
function parseCSV(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

module.exports = { parseCSV, parseCSVLine };
