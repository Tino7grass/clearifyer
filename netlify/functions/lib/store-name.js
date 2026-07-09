'use strict';
/**
 * Clearifyer · Store-Namen nach Deploy-Context trennen
 * -----------------------------------------------------
 * Netlify setzt process.env.CONTEXT automatisch auf einen von:
 *   "production" | "deploy-preview" | "branch-deploy" | "dev"
 *
 * Ziel: develop-/Preview-Deploys dürfen NIEMALS in denselben Blobs-Store
 * schreiben wie Produktion (sonst landen Test-Requests im echten
 * Audit-Log bzw. verändern den echten Ergebnis-Cache).
 *
 * Rückwärtskompatibel: Der Produktions-Store behält exakt seinen
 * bisherigen Namen (keine Migration nötig, kein Datenverlust). Nur
 * nicht-produktive Contexts bekommen einen Suffix.
 *
 * Fail-safe: Fehlt CONTEXT unerwartet (sollte in Netlify Functions nicht
 * vorkommen), wird NICHT stillschweigend in den Produktions-Store
 * geschrieben, sondern in einen sichtbar getrennten "-unknown"-Store.
 */
function contextualStoreName(baseName) {
  const ctx = process.env.CONTEXT || 'unknown';
  return ctx === 'production' ? baseName : `${baseName}-${ctx}`;
}

module.exports = { contextualStoreName };
