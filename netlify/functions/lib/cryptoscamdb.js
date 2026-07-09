'use strict';
/**
 * Clearifyer · Phase 1 · CryptoScamDB-Adapter
 * -------------------------------------------
 * Liefert ein Fraud-Signal fuer eine Adresse aus CryptoScamDB.
 *
 * DEFENSIV BY DESIGN: Der CryptoScamDB-Endpunkt hat sich als wechselhaft/
 * zeitweise nicht erreichbar erwiesen. Deshalb:
 *   - Feed-URL ist per ENV konfigurierbar (CRYPTOSCAMDB_CHECK_URL), kein
 *     hart verdrahteter Pfad, der bei Layout-Aenderung bricht.
 *   - Erreichbarkeits-/Timeout-Guard: Ist die Quelle nicht erreichbar, wird
 *     sie als `available:false` (degraded) gemeldet und traegt KEIN Signal bei.
 *     Fehlende Daten duerfen weder einen falschen Treffer noch ein falsches
 *     ALLOW erzeugen -> sie fliessen nur in DATA_COVERAGE_LOW ein.
 *
 * ENV:
 *   CRYPTOSCAMDB_CHECK_URL   z. B. "https://api.cryptoscamdb.org/v1/check/"
 *                            (die Adresse wird angehaengt). Ist die Variable
 *                            nicht gesetzt, ist der Adapter deaktiviert
 *                            (available:false) — bewusst, bis ein stabiler
 *                            Endpunkt bestaetigt ist.
 *
 * Rueckgabe:
 *   { source:'cryptoscamdb', available:boolean, reported:boolean,
 *     verified:boolean, reportCount:number, retrievedAt:string }
 */

const FETCH_TIMEOUT_MS = 6000;
const UA = 'clearifyer-screening/1.0 (+https://clearifyer.de)';

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
  } finally {
    clearTimeout(t);
  }
}

function disabled() {
  return {
    source: 'cryptoscamdb',
    available: false,
    reported: false,
    verified: false,
    reportCount: 0,
    retrievedAt: null,
  };
}

async function screenCryptoScamDB(address) {
  const base = process.env.CRYPTOSCAMDB_CHECK_URL;
  if (!base) return disabled(); // bewusst deaktiviert, bis Endpunkt bestaetigt

  const addr = String(address || '').trim();
  if (!addr) return disabled();

  const url = base.endsWith('/') ? base + encodeURIComponent(addr)
                                 : base + '/' + encodeURIComponent(addr);
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return disabled();
    const data = await res.json();

    // CryptoScamDB /check liefert typ. { success, result:{ status, entries? } }
    // status: "blocked" (auf Blacklist) | "neutral" | "whitelisted"
    const result = data && (data.result || data);
    const status = result && (result.status || result.type);
    const entries = (result && (result.entries || result.reports)) || [];
    const reported = status === 'blocked' || (Array.isArray(entries) && entries.length > 0);

    return {
      source: 'cryptoscamdb',
      available: true,
      reported: Boolean(reported),
      // CryptoScamDB-Eintraege gelten als community-kuratiert, aber nicht
      // einzeln "verifiziert" i. S. der Confidence-Regel -> verified:false.
      verified: false,
      reportCount: Array.isArray(entries) ? entries.length : (reported ? 1 : 0),
      retrievedAt: new Date().toISOString(),
    };
  } catch (_e) {
    return disabled(); // Timeout/Netzfehler -> degraded, kein Signal
  }
}

module.exports = { screenCryptoScamDB };
