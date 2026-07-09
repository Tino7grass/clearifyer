'use strict';
/**
 * Clearifyer · Phase 2 · ESMA Non-Compliant-Abgleich (namensbasiert)
 * -------------------------------------------------------------------
 * Prüft einen vom Nutzer im Kontextfeld genannten Gegenparteinamen gegen
 * ESMAs öffentliches, wöchentlich aktualisiertes Register nicht-konformer
 * Anbieter (NCASP.csv, Teil des Interim MiCA Register).
 *
 * WICHTIGER COMPLIANCE-HINWEIS: Ein Treffer bedeutet NICHT "diese Marke ist
 * verboten" — er bedeutet "diese juristische Person wurde von einer
 * konkreten nationalen Behörde wegen eines konkreten Verstoßes gemeldet,
 * z.B. Betrieb ohne Lizenz in einem bestimmten Mitgliedsstaat". Deshalb wird
 * bei jedem Treffer die Behörde, das Land und der Grund mitgeliefert — nie
 * nur ein Name allein. Ein global bekannter Markenname kann in einem Land
 * konform und in einem anderen als nicht-konform gemeldet sein.
 *
 * KONFIDENZ: Namens-Matching ist strukturell unsicherer als Adress-Matching
 * (Schreibweisen, Tochterfirmen, Namensgleichheit). Ein Treffer hier ist
 * daher NIEMALS ein Fail-Safe-Trigger wie bei den Sanktionslisten — bei
 * Nichtverfügbarkeit der Quelle wird NICHT automatisch blockiert, sondern
 * nur als geringere Datenabdeckung gewertet (siehe `available:false`).
 *
 * Rückgabe von checkCounterpartyESMA(name):
 *   {
 *     checked: boolean,       // wurde überhaupt ein Name übergeben?
 *     available: boolean,     // konnte die ESMA-Quelle geladen werden?
 *     matches: [{
 *       matchedName: string,          // ae_lei_name oder ae_commercial_name, der getroffen hat
 *       competentAuthority: string,   // z.B. "Netherlands Authority for the Financial Markets (AFM)"
 *       homeMemberState: string,      // 2-Buchstaben-Ländercode
 *       reason: string,               // Klartext-Begründung von ESMA/NCA
 *       infringement: string,         // Yes/No-Feld aus der Quelle
 *       decisionDate: string,
 *       website: string,
 *     }],
 *     retrievedAt: string | null,
 *   }
 */

const { parseCSV } = require('./csv-parse');

const NCASP_URL = 'https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv';
const CACHE_TTL_MS = 20 * 60 * 60 * 1000; // ~20h; ESMA aktualisiert wöchentlich, großzügig konservativ
const FETCH_TIMEOUT_MS = 10000;
const UA = 'clearifyer-screening/1.0 (+https://clearifyer.de)';

let _cache = null; // { rows, ts }

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/csv' } });
  } finally {
    clearTimeout(t);
  }
}

async function loadNCASP() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache;
  try {
    const res = await fetchWithTimeout(NCASP_URL);
    if (!res.ok) return _cache || null;
    const text = await res.text();
    const rows = parseCSV(text);
    const entry = { rows, ts: Date.now() };
    _cache = entry;
    return entry;
  } catch (_e) {
    return _cache || null;
  }
}

/**
 * Bidirektionaler Substring-Match nach Normalisierung. Bewusst einfach
 * gehalten (v1, kein Fuzzy-/Levenshtein-Matching) — deckt die häufigsten
 * Fälle ab ("Bitpanda" ⊂ "Bitpanda GmbH" und umgekehrt), erzeugt aber bei
 * sehr kurzen/generischen Namen potenziell False Positives. Fuzzy-Matching
 * ist als spätere Politur vorgesehen, nicht Teil dieses Minimal-Slices.
 */
function isNameMatch(inputNorm, candidateNorm) {
  if (!inputNorm || !candidateNorm) return false;
  if (inputNorm.length < 3) return false; // zu kurz für sinnvollen Substring-Match
  return candidateNorm.includes(inputNorm) || inputNorm.includes(candidateNorm);
}

async function checkCounterpartyESMA(counterpartyName) {
  const name = String(counterpartyName || '').trim();
  if (!name) {
    return { checked: false, available: null, matches: [], retrievedAt: null };
  }

  const data = await loadNCASP();
  if (!data) {
    return { checked: true, available: false, matches: [], retrievedAt: null };
  }

  const inputNorm = normalizeName(name);
  const matches = [];
  for (const row of data.rows) {
    const leiName = normalizeName(row.ae_lei_name);
    const commercialName = normalizeName(row.ae_commercial_name);
    if (isNameMatch(inputNorm, leiName) || isNameMatch(inputNorm, commercialName)) {
      matches.push({
        matchedName: row.ae_commercial_name || row.ae_lei_name || '',
        competentAuthority: row.ae_competentAuthority || '',
        homeMemberState: row.ae_homeMemberState || '',
        reason: row.ae_reason || '',
        infringement: row.ae_infrigment || row.ae_infringement || '',
        decisionDate: row.ae_decision_date || '',
        website: row.ae_website || '',
      });
    }
  }

  return {
    checked: true,
    available: true,
    matches,
    retrievedAt: new Date(data.ts).toISOString(),
  };
}

module.exports = { checkCounterpartyESMA, normalizeName, isNameMatch };
