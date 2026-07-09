'use strict';
/**
 * Clearifyer · Phase 1 · Fraud-Aggregator (Konfidenz-Regel)
 * ---------------------------------------------------------
 * Fasst Fraud-Adapter (CryptoScamDB, Chainabuse, spaeter ScamSniffer ...)
 * zu einem einzigen, deterministischen Signal zusammen und wendet die im
 * Konzeptpapier festgelegte Konfidenz-Trennung an:
 *
 *   SCAM_ADDRESS_CONFIRMED  wenn  (>= 2 unabhaengige Quellen melden)  ODER
 *                                 (mindestens eine Quelle meldet UND verified)
 *   SCAM_ADDRESS_REPORTED   wenn  genau eine, unverifizierte Quelle meldet
 *   null                    wenn  keine Quelle meldet
 *
 * `degraded` = true, wenn KEIN Adapter verfuegbar war -> Caller laesst das in
 * DATA_COVERAGE_LOW einfliessen (kein Treffer, kein ALLOW-Automatismus).
 *
 * Eingabe: Array von Adapter-Ergebnissen, je:
 *   { source, available, reported, verified, reportCount, retrievedAt }
 *
 * Adapter mit `available:false` werden ignoriert (tragen kein Signal bei),
 * zaehlen aber fuer die degraded-Erkennung.
 */

function classifyScam(adapterResults = []) {
  const results = Array.isArray(adapterResults) ? adapterResults : [];

  const available = results.filter((r) => r && r.available);
  const reporting = available.filter((r) => r.reported);
  const verifiedHit = reporting.some((r) => r.verified);
  const reportingSourceCount = reporting.length;

  let code = null; // kein Signal
  if (reportingSourceCount >= 2 || verifiedHit) {
    code = 'SCAM_ADDRESS_CONFIRMED';
  } else if (reportingSourceCount === 1) {
    code = 'SCAM_ADDRESS_REPORTED';
  }

  return {
    code,                                   // 'SCAM_ADDRESS_CONFIRMED' | 'SCAM_ADDRESS_REPORTED' | null
    reportingSources: reporting.map((r) => r.source),
    availableSources: available.map((r) => r.source),
    sourceCount: available.length,
    reportCount: reporting.reduce((s, r) => s + (r.reportCount || 0), 0),
    verified: verifiedHit,
    degraded: available.length === 0,
    retrievedAt: new Date().toISOString(),
  };
}

module.exports = { classifyScam };
