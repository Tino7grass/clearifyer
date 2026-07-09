'use strict';
/**
 * Clearifyer · Phase 1 · Chainabuse → scamInput Mapping
 * -----------------------------------------------------
 * Wandelt das Ergebnis von fetchChainabuse() in das Schema, das der
 * Fraud-Aggregator (classifyScam) erwartet.
 *
 * VORAUSSETZUNG: fetchChainabuse() liefert ein `available`-Flag (siehe
 * Patch in check.js). Ohne dieses Flag lässt sich "0 Meldungen" nicht von
 * "Abruf fehlgeschlagen" unterscheiden — genau die Silent-Failure-Klasse,
 * die wir vermeiden.
 *
 * Konfidenz: Chainabuse-Meldungen sind community-kuratiert und gelten
 * einzeln NICHT als verifiziert. Standard: verified:false → eine alleinige
 * Chainabuse-Meldung ergibt SCAM_ADDRESS_REPORTED (HOLD), nicht CONFIRMED.
 * Erst eine zweite unabhängige Quelle (z. B. CryptoScamDB) hebt den Fall
 * über die Konfidenz-Regel auf CONFIRMED.
 *
 * Optionaler Schalter: CHAINABUSE_CONFIRM_THRESHOLD (Zahl). Ist er > 0 und
 * die Meldungszahl >= Schwelle, wird der Treffer als verified gewertet — ein
 * allein stark gemeldeter Treffer erreicht dann CONFIRMED. Default 0 = aus
 * (bewusst konservativ; Community-Quelle allein soll nicht hart eskalieren).
 */

const CONFIRM_THRESHOLD = parseInt(process.env.CHAINABUSE_CONFIRM_THRESHOLD || '0', 10);

function chainabuseToScamInput(chainabuse) {
  const cb = chainabuse || {};
  const available = cb.available === true;
  const reportCount = Number.isFinite(cb.reports) ? cb.reports : 0;
  const reported = available && reportCount > 0;
  const verified = reported && CONFIRM_THRESHOLD > 0 && reportCount >= CONFIRM_THRESHOLD;

  return {
    source: 'chainabuse',
    available,
    reported,
    verified,
    reportCount,
    categories: Array.isArray(cb.categories) ? cb.categories : [],
    retrievedAt: new Date().toISOString(),
  };
}

module.exports = { chainabuseToScamInput };
