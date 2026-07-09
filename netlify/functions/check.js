// netlify/functions/check.js
// Clearifyer — API Aggregator v2.1
// Neu: Iknaio/GraphSense Integration
// Neu: Result Cache (Netlify Blobs) — spart externe API-Kosten

const { getStore } = require("@netlify/blobs");
const { contextualStoreName } = require("./lib/store-name");
const vaspList = require('./vasp-list.json');
const { checkCounterpartyESMA } = require("./lib/esma-noncompliant");
const { classifyScam } = require("./lib/fraud-aggregator");
const { chainabuseToScamInput } = require("./lib/chainabuse-map");
const { screenCryptoScamDB } = require("./lib/cryptoscamdb");

function lookupVASP(address) {
  if (!address) return null;
  const norm = address.toLowerCase().trim();
  for (const vasp of vaspList.vasps) {
    for (const addrs of Object.values(vasp.addresses)) {
      if (addrs.some(a => a.toLowerCase() === norm)) {
        return {
          name: vasp.name,
          jurisdiction: vasp.jurisdiction,
          micar_licensed: vasp.micar_licensed,
          travel_rule_applies: true
        };
      }
    }
  }
  return null;
}
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY  || "";
const CHAINABUSE_KEY = process.env.CHAINABUSE_API_KEY || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const MISTTRACK_KEY  = process.env.MISTTRACK_API_KEY  || "";
const IKNAIO_KEY     = process.env.IKNAIO_API_KEY     || "";

// ============================================================
// FETCH MIT TIMEOUT — verhindert, dass eine einzelne hängende
// externe API die gesamte Function über das Netlify-Zeitlimit
// zieht (Vorfall: Function lief 52s, Netlify-Timeout griff,
// Frontend bekam HTML-Fehlerseite statt JSON zurück).
//
// GA-02-Nachtrag (03.07.2026): Ohne eigenen User-Agent-Header senden
// Node-fetch-Clients teils gar keinen oder einen generischen UA-String.
// Manche Behörden-WAFs (u.a. treasury.gov) blocken genau das als
// Bot-Traffic — bestätigt durch einen direkten Testabruf, der ohne
// Header mit "bot detection" abgewiesen wurde. Default-Header setzen
// einen browsertypischen UA, außer options überschreibt ihn explizit.
// ============================================================
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache für Sanktionslisten (1h TTL) ──────────────────────
// _ofacLive / _euLive (GA-02): true = letzter Ladevorgang war ein erfolgreicher
// Live-Abgleich; false = es wird auf einen Fallback (OFAC) bzw. eine leere/veraltete
// Menge (EU) zurückgegriffen. Wird von deriveDecisionCode() ausgewertet, um bei
// Ausfall der Sanktionsquellen ein automatisches ALLOW zu verhindern.
let _ofacAddresses = null, _ofacTs = 0, _ofacLive = false;
let _euAddresses   = null, _euTs   = 0, _euLive   = false;
const CACHE_TTL = 60 * 60 * 1000;

// ============================================================
// RESULT CACHE (Netlify Blobs)
// Vermeidet wiederholte externe API-Calls für bekannte Adressen
// ============================================================

function getResultCacheStore() {
  return getStore({
    name: contextualStoreName("clearifyer-result-cache"),
    siteID: process.env.NETLIFY_SITE_ID || "24815739-0429-4422-8273-c4309c9b6753",
    token: process.env.NETLIFY_TOKEN
  });
}

// TTL je nach Risiko-Score (in Millisekunden)
function getCacheTTL(riskScore, sanctioned) {
  if (sanctioned)       return 0;              // Sanktionierte Adressen: kein Cache (immer live)
  if (riskScore >= 61)  return 1 * 60 * 60 * 1000;    // High Risk: 1 Stunde
  if (riskScore >= 21)  return 24 * 60 * 60 * 1000;   // Medium Risk: 24 Stunden
  return 7 * 24 * 60 * 60 * 1000;                     // Clean: 7 Tage
}

// Versionsnummer der GESAMTEN scoring-relevanten Logik — nicht nur applyScoreFloors().
// MUSS bei JEDER inhaltlichen Änderung hochgezählt werden, die das Ergebnis für eine
// bereits geprüfte Adresse verändern würde, also auch:
//   - checkIknaio() / checkMistTrack() / fetchEtherscan() / etc. (Datenquellen-Logik)
//   - der Claude-Prompt in analyzeWithClaude()
//   - applyScoreFloors() und die Floor-Texte
// Sonst liefert der Cache alte, ggf. fehlerhafte Ergebnisse weiter aus, obwohl der
// Code längst korrigiert wurde. Bisherige Vorfälle, die genau daran lagen:
//   v1→v2: widersprüchlicher Empfehlungstext blieb nach Fix im Cache aktiv
//   v2→v3: BNB/MATIC-Iknaio-Fix (kein Cross-Chain-Query mehr gegen "eth"-Graph)
//          blieb wirkungslos, weil alte Mixer-Labels noch unter v2 gecacht waren
//   v3→v4: ERC20-Token-Liste im Prompt auf Top 10 begrenzt (Performance-Fix für
//          token-reiche Adressen, die sonst die KI-Analyse ins Timeout liefen)
//   v4→v5: (vorherige Änderung, Grund nicht rückwirkend dokumentiert)
//   v5→v6: GA-02/GA-03 — OFAC/EU melden jetzt live:false statt stillem Fallback;
//          criticalSourceOutage + decisionCode/reasonCodes neu im Ergebnis.
//          Ohne diesen Versionssprung würden bereits gecachte Alt-Ergebnisse (ohne
//          decisionCode, mit dem alten EU-Ausfall-Bug) bis zu 7 Tage weiter ausgeliefert.
//   v6→v7: GA-02-Nachtrag — fehlender EU-FSF-Zugriffstoken ergänzt (Endpunkt lieferte
//          zuvor nie gültige Daten, nur wegen des v5→v6-Fixes überhaupt bemerkt) +
//          Standard-User-Agent-Header gegen Bot-Blocking bei treasury.gov ergänzt.
//          Ändert das live-Verhalten beider Sanktionsquellen — Alt-Cache ungültig.
//   v7→v8: GA-09/GA-13 — tenant_id und travel_rule_status neu im Cache-Key (Struktur
//          geändert, siehe getFromCache/saveToCache) sowie im Ergebnis/Audit-Log.
//          Neue Regel: travel_rule_status "missing"/"failed" kann HOLD auslösen.
const SCORE_LOGIC_VERSION = "v9";

// ============================================================
// GA-09 (schlanke Umsetzung, 03.07.2026)
// Vollständige Mandantenfähigkeit (getrennte Zugriffsrechte, eigene
// Policy Packs pro Kunde, Rollenmodell B-01) ist ein eigenes
// Sicherheitsthema für Phase B und gehört ins IT-Partner-Briefing.
// Diese Umsetzung deckt nur die Schema-Vorbereitung ab: tenant_id
// wird durchgängig durch Ergebnis, Audit-Log, Cache-Key und CSV-Export
// geführt, damit ein zweiter Pilotkunde später nicht nachträglich in
// jede Datenstruktur eingefügt werden muss. Ohne expliziten tenant_id
// im Request greift dieser Default — heutiges Verhalten bleibt für
// den laufenden Bitpanda-Piloten unverändert.
// ============================================================
const DEFAULT_TENANT_ID = "pilot-001";

async function getFromCache(address, network, context, tenantId, travelRuleStatus, counterpartyName) {
  try {
    const store = getResultCacheStore();
    // GA-09/GA-13: tenantId und travelRuleStatus gehören in den Cache-Key, weil beide
    // das Ergebnis (insb. den Decision Code) verändern können — ein Cache-Hit ohne diese
    // Unterscheidung würde sonst z.B. eine mit travel_rule_status="missing" berechnete
    // HOLD-Entscheidung fälschlich auch für "available" zurückgeben.
    const key = `${tenantId}:${network}:${address.toLowerCase()}:${context || "none"}:${travelRuleStatus || "none"}:${counterpartyName || "none"}:${SCORE_LOGIC_VERSION}`;
    const entry = await store.get(key, { type: "json" });
    if (!entry) return null;

    const ttl = getCacheTTL(entry.riskScore, entry.sanctioned);
    if (ttl === 0) return null; // Sanktioniert → immer neu prüfen

    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > ttl) return null; // Abgelaufen

    return entry;
  } catch {
    return null;
  }
}

async function saveToCache(address, network, context, tenantId, travelRuleStatus, counterpartyName, result) {
  try {
    // Sanktionierte Adressen nicht cachen
    if (result.sanctioned) return;

    const store = getResultCacheStore();
    const key = `${tenantId}:${network}:${address.toLowerCase()}:${context || "none"}:${travelRuleStatus || "none"}:${counterpartyName || "none"}:${SCORE_LOGIC_VERSION}`;
    await store.setJSON(key, {
      ...result,
      cachedAt: new Date().toISOString(),
      cacheHit: false
    });
  } catch (e) {
    console.error("Cache-Schreib-Fehler:", e.message);
  }
}

// ============================================================
// 1. ADRESSVALIDIERUNG & CHAIN-ERKENNUNG
// ============================================================

function validateAddress(addr, network) {
  const patterns = {
    eth:   /^0x[0-9a-fA-F]{40}$/,
    bnb:   /^0x[0-9a-fA-F]{40}$/,
    matic: /^0x[0-9a-fA-F]{40}$/,
    btc:   /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$|^bc1[0-9a-z]{6,87}$/,
    sol:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    trx:   /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  };
  if (!patterns[network]) return { valid: true };
  return { valid: patterns[network].test(addr) };
}

function detectChainFromAddress(addr) {
  if (!addr) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(addr))                          return "eth";
  if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr) ||
      /^bc1[a-z0-9]{39,59}$/.test(addr))                         return "btc";
  if (/^T[a-km-zA-HJ-NP-Z1-9]{33}$/.test(addr))                 return "trx";
  return null;
}

// ============================================================
// 2. ENS-AUFLÖSUNG
// ============================================================

async function resolveENS(input) {
  if (!input) return { address: input, wasENS: false };
  const trimmed = input.trim();

  if (!trimmed.toLowerCase().endsWith(".eth")) {
    return { address: trimmed, wasENS: false };
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.etherscan.io/api?module=account&action=getaddress&ens=${trimmed}&apikey=${ETHERSCAN_KEY}`
    );
    const data = await res.json();
    if (data.result && /^0x[a-fA-F0-9]{40}$/.test(data.result)) {
      return { address: data.result.toLowerCase(), wasENS: true, ensName: trimmed };
    }
  } catch (e) { /* Fallthrough */ }

  return { address: null, wasENS: true, error: `ENS "${trimmed}" konnte nicht aufgelöst werden.` };
}

// ============================================================
// DEMO-WHITELIST — nur diese Adressen sind im Demo-Modus prüfbar
// ============================================================
const DEMO_WHITELIST = new Set([
 "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
]);

// ============================================================
// 3. OFAC SDN LIST
// ============================================================

const OFAC_HARDLIST = new Set([
  // Tornado Cash (OFAC 08/2022, SDN-Programm CYBER2)
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0x722122df12d4e14e13ac3b6895a86e84145b6967",
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd96f2b1c14db8458374d9aca76e26c3950113949",
  "0x4736dcf1b7a3d580672cce6e7c65cd5cc9cfba9d",
  "0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
  "0xa160cdab225685da1d56aa342ad8841c3b53f291",
  "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144",
  "0xf60dd140cff0706bae9cd734ac3ae76ad9ebc32a",
  "0x22aaa7720ddd5388a3c0a3333430953c68f1849b",
  "0xba214c1c1928a32bffe790263e38b4af9bfcd659",
  "0xb1c8094b234dce6e03f10a5b673c1d8c69739a00",
  "0x527653ea119f3e6a1f5bd18fbf4714081d7b31ce",
  "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2",
  "0xd691f27f38b395864ea86cfc7253969b409c362d",
  "0xaf4c0b70b2ea9fb7487c7cbb37ada259579fe040",
  "0xa5c2254e4253490c54cef0a4347fddb8f75a4998",
  "0x1356c899d8c9467c7f71c195612f8a395abf2f0a",
  "0x169ad27a470d064dede56a2d3ff727986b15d52b",
  "0x0836222f2b2b5a6430604607e9ae5b26c78a3bfd",
  "0xf67721a2d8f736e75a49fdc940616ad24db81c35",
  "0x9ad122c22b14202b4490edaf288fdb3c7cb3ff5e",
  "0x905b63fff465b9ffbf41dea908ceb12478ec7601",
  "0x07687e702b410fa43f4cb4af7fa097918ffd2730",
  "0x94a1b5cdb22c43faab4abeb5c74999895464ddaf",
  "0xb541fc07bc7619fd4062a54d96268525cbc6ffef",
  "0xce0042b868300000d44a59004da54a005ffdcf9f",
  "0x23773e65ed146a459667ad917a0f3f3bb6b3e7df",
  "0x77777feddddffc19ff86db637967013e020f3b0a",
  "0x3efa30704d2b8bbac821307230376556cf8cc39e",
  // Lazarus Group / DPRK (OFAC)
  "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
  "0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b",
  "0x3ad9db589d201a710811928d3cbfe2eba228502e",
].map(a => a.toLowerCase()));

async function loadOFAC() {
  // WICHTIG (GA-02): _ofacLive markiert, ob die zuletzt geladene Liste aus einem
  // erfolgreichen Live-Abgleich stammt oder aus dem statischen OFAC_HARDLIST-Fallback.
  // Diese Unterscheidung ist scharf zu halten — sie entscheidet später, ob ein
  // "kein Treffer"-Ergebnis als geprüft ("clear") oder als ungeprüft ("unknown")
  // gilt (siehe checkOFAC / deriveDecisionCode).
  if (_ofacAddresses && Date.now() - _ofacTs < CACHE_TTL) {
    return { addresses: _ofacAddresses, live: _ofacLive };
  }
  try {
    const res = await fetchWithTimeout("https://www.treasury.gov/ofac/downloads/sdn.csv", {}, 10000);
    if (!res.ok) {
      _ofacAddresses = new Set(OFAC_HARDLIST);
      _ofacTs = Date.now();
      _ofacLive = false;
      return { addresses: _ofacAddresses, live: false };
    }
    const text = await res.text();
    const matches = text.match(/0x[a-fA-F0-9]{40}/gi) || [];
    const fromCsv = new Set(matches.map(a => a.toLowerCase()));
    _ofacAddresses = new Set([...fromCsv, ...OFAC_HARDLIST]);
    _ofacTs = Date.now();
    _ofacLive = true;
    return { addresses: _ofacAddresses, live: true };
  } catch {
    _ofacAddresses = new Set(OFAC_HARDLIST);
    _ofacTs = Date.now();
    _ofacLive = false;
    return { addresses: _ofacAddresses, live: false };
  }
}

async function checkOFAC(address) {
  const { addresses: set, live } = await loadOFAC();
  const sanctioned = set.has(address.toLowerCase());
  return {
    sanctioned,
    live,
    // GA-02: Ohne Live-Abgleich ist "kein Treffer" kein "clear", sondern "unknown" —
    // die Kernliste (OFAC_HARDLIST) deckt nur bekannte Altfälle ab, nicht die
    // aktuelle vollständige SDN-Liste.
    risk: sanctioned ? "critical" : (live ? "clear" : "unknown"),
    detail: sanctioned
      ? "⛔ Adresse steht auf der US-Sanktionsliste (OFAC SDN). Transaktion rechtlich verboten."
      : live
        ? "✅ Nicht auf der OFAC SDN-Liste gefunden."
        : "⚠️ OFAC-Live-Abgleich fehlgeschlagen — Prüfung erfolgte nur gegen die zuletzt bekannte Kernliste (Fallback), nicht gegen die aktuelle vollständige SDN-Liste."
  };
}

// ============================================================
// 4. EU-SANKTIONSLISTEN
// ============================================================

async function loadEU() {
  // GA-02 FIX: Vorher gab ein fehlgeschlagener Live-Abgleich (res.ok===false ODER
  // Netzwerkfehler) einen LEEREN Set zurück — ohne jede Kennzeichnung. Eine tatsächlich
  // sanktionierte Adresse wäre in diesem Fall als "sauber" durchgelaufen, weil es
  // (anders als bei OFAC) keine statische Fallback-Liste gibt. Fix: Ausfall wird
  // explizit signalisiert (live:false); die zuletzt bekannte Menge wird nur als
  // Fallback verwendet, niemals stillschweigend als vollständige Prüfung behandelt.
  if (_euAddresses && Date.now() - _euTs < CACHE_TTL) {
    return { addresses: _euAddresses, live: _euLive };
  }
  try {
    const res = await fetchWithTimeout(
      // GA-02-Nachtrag (03.07.2026): Der ursprünglichen URL fehlte der Pflicht-Parameter
      // "?token=...". Die EU FSF (Financial Sanctions Files) verlangen für den
      // öffentlichen/automatisierten Zugriff diesen Token — ohne ihn liefert der Endpunkt
      // keine gültige Sanktionsliste zurück. "dG9rZW4tMjAxNw" ist der offiziell
      // dokumentierte öffentliche Zugriffstoken für automatisierten/Crawler-Zugriff auf
      // die FSF-Public-Files (base64 von "token-2017"), verifiziert per Testabruf: liefert
      // gültiges XML zurück. Dieser Bug ist vermutlich der Grund, warum der EU-Abgleich
      // seit jeher wirkungslos war — nur wegen des alten loadEU()-Fallback-Bugs (leerer
      // Set statt Fehler) ist das nie aufgefallen.
      "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
      {}, 10000
    );
    if (!res.ok) {
      _euTs = Date.now();
      _euLive = false;
      return { addresses: _euAddresses || new Set(), live: false };
    }
    const xml = await res.text();
    const matches = xml.match(/0x[a-fA-F0-9]{40}/g) || [];
    _euAddresses = new Set(matches.map(a => a.toLowerCase()));
    _euTs = Date.now();
    _euLive = true;
    return { addresses: _euAddresses, live: true };
  } catch {
    _euTs = Date.now();
    _euLive = false;
    return { addresses: _euAddresses || new Set(), live: false };
  }
}

async function checkEUSanctions(address) {
  const { addresses: set, live } = await loadEU();
  const sanctioned = set.has(address.toLowerCase());
  return {
    sanctioned,
    live,
    // GA-02: kein Live-Abgleich ⇒ "unknown", NICHT "clear" — dies ist die
    // Kernkorrektur, die ein automatisches Grün bei EU-Feed-Ausfall verhindert.
    risk: sanctioned ? "critical" : (live ? "clear" : "unknown"),
    detail: sanctioned
      ? "⛔ Adresse steht auf der EU-Sanktionsliste. Transaktion verstößt gegen EU-Recht."
      : live
        ? "✅ Nicht auf der EU-Sanktionsliste gefunden."
        : "⚠️ EU-Sanktions-Livequelle nicht erreichbar — kein aktueller Abgleich möglich. Diese Prüfung gilt als NICHT durchgeführt, nicht als \"sauber\"."
  };
}

// ============================================================
// 5. ETHERSCAN
// ============================================================

// Bekannte Stablecoin-Contracts (Ethereum Mainnet) — für Token-Transfer-Filterung
const KNOWN_TOKEN_CONTRACTS = {
  eth: {
    USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
};

async function fetchEtherscan(addr, network) {
  const chainIds = { eth: 1, bnb: 56, matic: 137 };
  const chainId  = chainIds[network];
  if (!chainId || !ETHERSCAN_KEY) return { skipped: true };

  try {
    const base = `https://api.etherscan.io/v2/api?chainid=${chainId}&apikey=${ETHERSCAN_KEY}`;
    const [balRes, txAscRes, txDescRes, codeRes, tokenTxRes] = await Promise.all([
      fetchWithTimeout(`${base}&module=account&action=balance&address=${addr}&tag=latest`),
      fetchWithTimeout(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=1&sort=asc`),
      fetchWithTimeout(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=100&sort=desc`),
      fetchWithTimeout(`${base}&module=proxy&action=eth_getCode&address=${addr}&tag=latest`),
      fetchWithTimeout(`${base}&module=account&action=tokentx&address=${addr}&page=1&offset=100&sort=desc`)
    ]);

    const balData    = await balRes.json();
    const txAscData  = await txAscRes.json();
    const txDescData = await txDescRes.json();
    const codeData   = await codeRes.json();
    const tokenTxData = await tokenTxRes.json();

    const balanceEth = balData.status === "1"
      ? (parseFloat(balData.result) / 1e18).toFixed(6) : null;

    let txCount = 0, firstTxDate = null, lastTxDate = null, receivesOnly = false, velocity24h = 0;
    const now = Math.floor(Date.now() / 1000);

    if (txAscData.status === "1" && Array.isArray(txAscData.result) && txAscData.result.length > 0) {
      firstTxDate = new Date(parseInt(txAscData.result[0].timeStamp) * 1000).toLocaleDateString("de-DE");
    }

    if (txDescData.status === "1" && Array.isArray(txDescData.result) && txDescData.result.length > 0) {
      const txs = txDescData.result;
      txCount    = txs.length;
      lastTxDate = new Date(parseInt(txs[0].timeStamp) * 1000).toLocaleDateString("de-DE");
      receivesOnly = txs.every(tx => tx.to?.toLowerCase() === addr.toLowerCase());
      velocity24h  = txs.filter(tx => parseInt(tx.timeStamp) > now - 86400).length;
    }

    // ── ERC20 Token-Historie auswerten (insb. USDT/USDC) ──────
    let tokenTransfers = { available: false, totalCount: 0, byToken: {} };
    if (tokenTxData.status === "1" && Array.isArray(tokenTxData.result)) {
      const transfers = tokenTxData.result;
      const grouped = {};
      for (const t of transfers) {
        const symbol = t.tokenSymbol || t.tokenName || t.contractAddress;
        if (!grouped[symbol]) {
          grouped[symbol] = { count: 0, lastTxDate: null, contract: t.contractAddress, receivedOnly: true };
        }
        grouped[symbol].count++;
        grouped[symbol].lastTxDate = new Date(parseInt(t.timeStamp) * 1000).toLocaleDateString("de-DE");
        if (t.to?.toLowerCase() !== addr.toLowerCase()) grouped[symbol].receivedOnly = false;
      }
      tokenTransfers = { available: true, totalCount: transfers.length, byToken: grouped };
    } else if (tokenTxData.message === "No transactions found") {
      tokenTransfers = { available: true, totalCount: 0, byToken: {} };
    }

    let velocityRisk = "low";
    let velocityDetail = `${velocity24h} Transaktion(en) in den letzten 24h — unauffällig.`;
    if (velocity24h > 20)     { velocityRisk = "high";   velocityDetail = `🚨 ${velocity24h} Transaktionen in 24h — möglicher Mixer/Tumbler.`; }
    else if (velocity24h > 5) { velocityRisk = "medium"; velocityDetail = `⚠️ ${velocity24h} Transaktionen in 24h — erhöhte Aktivität.`; }

    const bytecode   = codeData.result;
    const isContract = typeof bytecode === "string" && bytecode !== "0x" && bytecode !== "" && bytecode.length > 100;
    let contractRisk = "neutral";
    let contractDetail = "✅ Normale Wallet-Adresse (kein Smart Contract).";

    if (isContract) {
      try {
        const srcRes  = await fetchWithTimeout(`${base}&module=contract&action=getsourcecode&address=${addr}`);
        const srcData = await srcRes.json();
        const info    = srcData.result?.[0] || {};
        const verified = info.SourceCode && info.SourceCode !== "";
        contractRisk   = verified ? "low" : "high";
        contractDetail = verified
          ? `✅ Verifizierter Smart Contract: "${info.ContractName || "Unbekannt"}".`
          : `⚠️ Nicht verifizierter Smart Contract — erhöhtes Risiko.`;
      } catch { contractRisk = "medium"; contractDetail = "⚠️ Smart Contract — Verifizierung nicht prüfbar."; }
    }

    return {
      balanceEth, txCount, firstTxDate, lastTxDate, receivesOnly,
      velocity: { velocity24h, risk: velocityRisk, detail: velocityDetail },
      contract: { isContract, risk: contractRisk, detail: contractDetail },
      tokenTransfers
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// 6. CHAINABUSE
// ============================================================

async function fetchChainabuse(addr) {
  if (!CHAINABUSE_KEY) return { available: false, reports: 0, categories: [] };
  try {
    const res = await fetchWithTimeout(
      `https://www.chainabuse.com/api/reports/search?address=${encodeURIComponent(addr)}`,
      { headers: { "X-API-Key": CHAINABUSE_KEY } }
    );
    if (!res.ok) return { available: false, reports: 0, categories: [] };
    const data = await res.json();
    return {
      available: true,
      reports: data.totalCount ?? 0,
      categories: [...new Set((data.reports || []).map(r => r.scamCategory).filter(Boolean))]
    };
  } catch { return { available: false, reports: 0, categories: [] }; }
}

// ============================================================
// 7. MISTTRACK AML (Developer Plan — GET API)
// ============================================================

const MISTTRACK_RISKY_COUNTERPARTIES = [
  "tornado", "mixer", "tumbler", "darknet", "dark web",
  "ransomware", "lazarus", "hack", "stolen", "coinjoin",
  "wasabi", "chipmixer", "helix", "sanctioned", "illicit"
];

async function checkMistTrack(address, network) {
  if (!MISTTRACK_KEY) return { available: false, detail: "MistTrack nicht konfiguriert.", risk: "unknown" };

  const chainMap = { eth: "ETH", btc: "BTC", trx: "TRX", bnb: "BNB", matic: "MATIC" };
  const coin = chainMap[network] || "ETH";

  const base = `https://openapi.misttrack.io`;
  const params = `coin=${coin}&address=${encodeURIComponent(address)}&api_key=${MISTTRACK_KEY}`;

  try {
    const [riskRes, counterpartyRes] = await Promise.all([
      fetchWithTimeout(`${base}/v3/risk_score?${params}`),
      fetchWithTimeout(`${base}/v1/address_counterparty?${params}`)
    ]);

    const riskData         = await riskRes.json();
    const counterpartyData = await counterpartyRes.json();

    const riskScore  = riskData?.data?.score ?? null;
    const detailList = riskData?.data?.detail_list ?? [];
    const riskDetail = riskData?.data?.risk_detail ?? [];
    const labels     = [
      ...detailList,
      ...riskDetail.map(r => `${r.entity} (${r.risk_type})`).filter(Boolean)
    ];

    let risk = "neutral";
    let scoreDetail = "";

    if (riskScore !== null) {
      if (riskScore >= 70) {
        risk        = "high";
        scoreDetail = `🚨 MistTrack Score: ${riskScore}/100 (HOCH). Labels: ${labels.join(", ") || "–"}.`;
      } else if (riskScore >= 40) {
        risk        = "medium";
        scoreDetail = `⚠️ MistTrack Score: ${riskScore}/100 (MITTEL). Labels: ${labels.join(", ") || "–"}.`;
      } else {
        risk        = "low";
        scoreDetail = `✅ MistTrack Score: ${riskScore}/100 (GERING). Labels: ${labels.join(", ") || "–"}.`;
      }
    }

    const counterpartyList    = counterpartyData?.address_counterparty_list ?? [];
    const flaggedCounterparties = [];
    let   counterpartyBoost   = 0;
    let   counterpartyDetail  = "";

    if (counterpartyList.length > 0) {
      const top5 = counterpartyList.slice(0, 5);
      counterpartyDetail = "Gegenparteien: " + top5
        .map(c => `${c.name} (${c.percent?.toFixed(1)}%)`)
        .join(", ");

      for (const cp of counterpartyList) {
        const nameLower = (cp.name || "").toLowerCase();
        if (MISTTRACK_RISKY_COUNTERPARTIES.some(t => nameLower.includes(t))) {
          flaggedCounterparties.push(`${cp.name} (${cp.percent?.toFixed(1)}%)`);
          counterpartyBoost += Math.min(cp.percent / 2, 25);
        }
      }

      if (flaggedCounterparties.length > 0) {
        if (risk === "low" || risk === "neutral") risk = "high";
        counterpartyDetail += ` ⚠️ Risiko-Gegenparteien: ${flaggedCounterparties.join(", ")}`;
      }
    }

    const detail = [scoreDetail, counterpartyDetail].filter(Boolean).join(" | ");

    return {
      available: true,
      riskScore,
      labels,
      counterpartyList,
      flaggedCounterparties,
      counterpartyBoost: Math.round(counterpartyBoost),
      risk,
      detail
    };

  } catch (e) {
    return { available: false, risk: "unknown", detail: "MistTrack vorübergehend nicht verfügbar." };
  }
}

// ============================================================
// 8. IKNAIO / GRAPHSENSE
// ============================================================

async function checkIknaio(address, network) {
  if (!IKNAIO_KEY) {
    return { available: false, detail: "Iknaio nicht konfiguriert.", risk: "unknown" };
  }

  // BNB/MATIC NICHT gegen den Ethereum-Entitätsgraphen abfragen.
  // Live bestätigt (Testlauf): eine BNB-Adresse wurde fälschlich gegen GraphSenses
  // "eth"-Graph geprüft und bekam Mixer-/Risiko-Labels zugeordnet, die zu einer
  // strukturell identisch aussehenden, aber chain-fremden Adresse gehören können —
  // nicht zur tatsächlichen BNB-Chain-Aktivität. Das floss bisher unbemerkt in den
  // Score ein. Lieber transparent "nicht unterstützt" als ein falsches Ergebnis.
  if (network === "bnb" || network === "matic") {
    return {
      available: false,
      risk: "unknown",
      detail: `Iknaio/GraphSense unterstützt ${network.toUpperCase()} aktuell nicht direkt. Eine Abfrage gegen den Ethereum-Graphen würde chain-fremde Treffer liefern und wird daher nicht durchgeführt.`,
    };
  }

  const chainMap = { eth: "eth", btc: "btc", trx: "trx" };
  const currency = chainMap[network] || null;
  if (!currency) {
    return { available: false, risk: "unknown", detail: `Iknaio/GraphSense unterstützt ${network} nicht.` };
  }

  const BASE = "https://api.ikna.io";
  const headers = {
    "Authorization": IKNAIO_KEY,
    "Accept": "application/json"
  };

  try {
    const [addrRes, tagsRes] = await Promise.all([
      fetchWithTimeout(`${BASE}/${currency}/addresses/${address}`, { headers }),
      fetchWithTimeout(`${BASE}/${currency}/addresses/${address}/tags`, { headers })
    ]);

    let addrData = null;
    if (addrRes.ok) {
      addrData = await addrRes.json();
    }

    let tags = [];
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      tags = tagsData.address_tags || tagsData.tags || [];
    }

    const labels = tags.map(t => t.label || t.category || "").filter(Boolean);
    const concepts = [...new Set(tags.map(t => t.concept || "").filter(Boolean))];
    const abuses = tags.filter(t => t.abuse).map(t => t.abuse);

    let neighborRisk = "neutral";
    let neighborFindings = [];

    const entityId = addrData?.entity?.entity;
    if (entityId) {
      try {
        const neighborRes = await fetchWithTimeout(
          `${BASE}/${currency}/entities/${entityId}/neighbors?direction=both&include_labels=true&pagesize=20`,
          { headers }
        );
        if (neighborRes.ok) {
          const neighborData = await neighborRes.json();
          const neighbors = neighborData.neighbors || [];

          const dangerousNeighborKeywords = ["mixer", "tumbler", "darknet", "scam", "ransomware", "hack", "sanctioned", "terrorism", "illicit"];

          for (const neighbor of neighbors) {
            const nLabels = (neighbor.labels || []).map(l => (l.label || l || "").toLowerCase());
            const nAbuses = neighbor.abuse || [];
            const nId     = neighbor.entity?.entity || neighbor.entity;

            const isDangerous = nAbuses.length > 0 ||
              nLabels.some(l => dangerousNeighborKeywords.some(d => l.includes(d)));

            if (isDangerous) {
              neighborFindings.push({
                entityId: nId,
                labels: nLabels.filter(Boolean),
                abuses: nAbuses,
              });
            }
          }

          if (neighborFindings.length > 0) {
            neighborRisk = "high";
          }
        }
      } catch (e) {
        console.warn("Iknaio Neighbor-Check Fehler:", e.message);
      }
    }

    const dangerousKeywords = ["mixer", "tumbler", "darknet", "scam", "ransomware", "hack", "sanctioned", "terrorism"];
    const safeKeywords      = ["exchange", "defi", "cex", "wallet_provider", "mining_pool"];

    let risk = "neutral";
    let detail = "";

    if (abuses.length > 0) {
      risk   = "high";
      detail = `🚨 Iknaio: Missbrauch gemeldet — ${abuses.join(", ")}. Labels: ${labels.join(", ") || "keine"}.`;
    } else if (labels.some(l => dangerousKeywords.some(d => l.toLowerCase().includes(d)))) {
      risk   = "high";
      detail = `🚨 Iknaio: Risiko-Labels gefunden: ${labels.join(", ")}.`;
    } else if (neighborFindings.length > 0) {
      risk   = "high";
      const count = neighborFindings.length;
      const sample = neighborFindings.slice(0, 3).map(n =>
        n.abuses.length > 0 ? n.abuses[0] : n.labels[0] || "unbekannt"
      ).join(", ");
      detail = `🚨 Iknaio: ${count} auffällige Nachbar-Entität(en) im Transaktionsgraph (${sample}).`;
    } else if (labels.some(l => safeKeywords.some(s => l.toLowerCase().includes(s)))) {
      risk   = "low";
      detail = `✅ Iknaio: Bekannte vertrauenswürdige Entität. Labels: ${labels.join(", ")}.`;
    } else if (labels.length > 0) {
      risk   = "low";
      detail = `Iknaio: Adresse bekannt. Labels: ${labels.join(", ")}.`;
    } else {
      risk   = "neutral";
      detail = "Iknaio: Keine Attribution gefunden (neue oder unbekannte Adresse).";
    }

    const entityInfo = addrData?.entity
      ? { id: entityId, noAddresses: addrData.entity.no_addresses }
      : null;

    return {
      available: true,
      risk,
      detail,
      labels,
      concepts,
      abuses,
      neighborFindings,
      entity: entityInfo,
      totalTxs: addrData?.no_txs ?? null,
      firstTx: addrData?.first_tx?.timestamp
        ? new Date(addrData.first_tx.timestamp * 1000).toLocaleDateString("de-DE")
        : null,
      lastTx: addrData?.last_tx?.timestamp
        ? new Date(addrData.last_tx.timestamp * 1000).toLocaleDateString("de-DE")
        : null,
    };

  } catch (e) {
    console.error("Iknaio Fehler:", e.message);
    return { available: false, risk: "unknown", detail: "Iknaio vorübergehend nicht verfügbar." };
  }
}

// ============================================================
// 8b. DATENQUELLEN-COVERAGE — welche Chain unterstützt welche Quelle wirklich
// ============================================================

// Explizite Wahrheit statt stillschweigender Fallbacks in den Fetchern.
const CHAIN_SOURCE_SUPPORT = {
  eth:   { etherscan: true,  misttrack: true,  iknaio: true  },
  bnb:   { etherscan: true,  misttrack: true,  iknaio: false }, // Iknaio mapped bnb->eth: fachlich nicht belastbar
  matic: { etherscan: true,  misttrack: true,  iknaio: false }, // gleiches Problem
  btc:   { etherscan: false, misttrack: true,  iknaio: true  },
  trx:   { etherscan: false, misttrack: true,  iknaio: true  },
  sol:   { etherscan: false, misttrack: false, iknaio: false }, // aktuell von KEINER Quelle wirklich unterstützt
};

function buildDataSourceStatus({ network, onChain, chainabuse, misttrack, iknaio, ofac, euSanctions }) {
  const support = CHAIN_SOURCE_SUPPORT[network] || { etherscan: false, misttrack: false, iknaio: false };

  return {
    // GA-02: responded/usedInScore spiegeln jetzt den echten Live-Status wider
    // (ofac.live / euSanctions.live), statt fest auf true zu stehen.
    ofac: { requested: true, responded: ofac.live === true, usedInScore: ofac.live === true },
    euSanctions: { requested: true, responded: euSanctions.live === true, usedInScore: euSanctions.live === true },
    chainabuse: {
      requested: !!CHAINABUSE_KEY,
      responded: !!CHAINABUSE_KEY && chainabuse?.reports !== undefined,
      usedInScore: !!CHAINABUSE_KEY,
    },
    etherscan: {
      chainSupported: support.etherscan,
      requested: support.etherscan,
      responded: support.etherscan && !onChain?.error && !onChain?.skipped,
      usedInScore: support.etherscan && !onChain?.error && !onChain?.skipped,
    },
    misttrack: {
      chainSupported: support.misttrack,
      requested: support.misttrack && !!MISTTRACK_KEY,
      responded: support.misttrack && misttrack?.available === true,
      usedInScore: support.misttrack && misttrack?.available === true,
    },
    iknaio: {
      chainSupported: support.iknaio,
      requested: support.iknaio && !!IKNAIO_KEY,
      responded: support.iknaio && iknaio?.available === true,
      usedInScore: support.iknaio && iknaio?.available === true,
    },
  };
}

// Vollständigkeits-Score: wie viele relevante, für diese Chain unterstützte
// Quellen haben tatsächlich geantwortet und sind in die Bewertung eingeflossen
function calcCoverageRatio(status) {
  const relevant = Object.values(status).filter(s =>
    s.chainSupported === true || s.chainSupported === undefined
  );
  const used = relevant.filter(s => s.usedInScore).length;
  return relevant.length > 0 ? used / relevant.length : 1;
}

// ============================================================
// 8c. HARTE SCORE-FLOORS (Code-Override nach der KI-Antwort)
// Diese Regeln gelten IMMER, unabhängig davon, was die KI ausgibt.
// Sie können den Score nur nach OBEN korrigieren, nie nach unten.
// ============================================================

const SUPPORT_LEAK_CONTEXT_VALUES = new Set([
  "support", // entspricht id="ctx-support" in app.html: "Support schickte sie mir (Telegram, WhatsApp, E-Mail)"
]);

function applyScoreFloors({ aiResult, isSanctioned, sanctionSource, iknaio, misttrack, context, coverageRatio }) {
  let score = typeof aiResult.riskScore === "number" ? aiResult.riskScore : 0;
  let level = aiResult.riskLevel || "GERING";
  const appliedFloors = [];
  let recommendation = aiResult.recommendation || "";

  // Floor 1: Sanktionen sind ein Code-Override, kein Prompt-Vorschlag
  if (isSanctioned) {
    if (score !== 100) appliedFloors.push(`Sanktionstreffer (${sanctionSource}) erzwingt Score 100, KI gab ${score} aus.`);
    score = 100;
    level = "KRITISCH";
    recommendation = `⛔ SANKTIONSTREFFER (${sanctionSource}). Diese Bewertung wird unabhängig von der KI-Einschätzung durch eine Code-Regel erzwungen, da Sanktionsverstöße rechtlich keine Ermessensfrage sind. ${recommendation}`.trim();
  }

  // Floor 2: Iknaio-Missbrauchsmeldung erzwingt Mindest-Score HOCH
  if (!isSanctioned && Array.isArray(iknaio?.abuses) && iknaio.abuses.length > 0 && score < 70) {
    appliedFloors.push(`Iknaio meldet Missbrauch (${iknaio.abuses.join(", ")}), KI-Score (${score}) lag unter Floor 70.`);
    score = Math.max(score, 70);
    level = "HOCH";
  }

  // Floor 3: MistTrack flaggt Risiko-Gegenparteien erzwingt Mindest-Score HOCH
  if (!isSanctioned && Array.isArray(misttrack?.flaggedCounterparties) && misttrack.flaggedCounterparties.length > 0 && score < 70) {
    appliedFloors.push(`MistTrack flaggt Risiko-Gegenparteien (${misttrack.flaggedCounterparties.join(", ")}), KI-Score (${score}) lag unter Floor 70.`);
    score = Math.max(score, 70);
    level = "HOCH";
  }

  // Floor 4: Kontext "Support schickte mir die Adresse" erzwingt Mindest-Score + Pflicht-Disclaimer.
  // WICHTIG: Der KI-Empfehlungstext wird hier ERSETZT, nicht nur ergänzt — sonst kann der
  // ursprüngliche KI-Text (z.B. "unverdächtig, keine Due-Diligence nötig") dem erzwungenen
  // Warnhinweis im selben Absatz widersprechen.
  if (!isSanctioned && SUPPORT_LEAK_CONTEXT_VALUES.has(context) && score < 60) {
    appliedFloors.push(`Kontext "Support schickte Adresse" erzwingt Floor 60, KI-Score (${score}) lag darunter.`);
    score = Math.max(score, 60);
    level = score >= 70 ? "HOCH" : "MITTEL";
    recommendation = `⚠️ WARNUNG: Du hast angegeben, dass diese Adresse dir vom "Support" über Telegram/WhatsApp/E-Mail geschickt wurde. Kein legitimer Kundendienst verschickt jemals eine externe Wallet-Adresse zur Einzahlung — das ist ein klassisches Pig-Butchering-Muster, unabhängig davon, wie sauber die On-Chain-Historie der Adresse aussieht. Sende kein Geld an diese Adresse, ohne den Auftraggeber über einen unabhängigen, verifizierten Kanal zu kontaktieren (nicht über denselben Chat, der dir die Adresse geschickt hat).\n\nZur Einordnung: Die On-Chain-Analyse selbst zeigt ${aiResult.summary ? aiResult.summary.replace(/\.$/, "") : "keine Sanktions- oder Missbrauchstreffer"}. Das entkräftet die Kontext-Warnung jedoch NICHT — eine technisch saubere Adresse schützt nicht vor Betrug, wenn der Übermittlungsweg verdächtig ist.`;
  }

  // Floor 5: Datenlücke transparent machen, wenn Coverage niedrig ist
  if (coverageRatio < 0.6) {
    appliedFloors.push(`Niedrige Datenabdeckung (${Math.round(coverageRatio * 100)}%) für diese Chain.`);
    recommendation = `${recommendation}\n\nHinweis: Für diese Chain konnten nicht alle relevanten Datenquellen abgerufen oder ausgewertet werden (Abdeckung: ${Math.round(coverageRatio * 100)}%). Der Score ist entsprechend mit eingeschränkter Verlässlichkeit zu betrachten.`.trim();
  }

  return {
    riskScore: score,
    riskLevel: level,
    recommendation,
    summary: aiResult.summary,
    findings: aiResult.findings,
    appliedFloors,
    scoreOverridden: appliedFloors.length > 0,
  };
}

// ============================================================
// 8d. DECISION CODE (GA-03)
// Policy before score: der Score/Level aus applyScoreFloors() ist ein Zwischen-
// ergebnis, keine Handlungsanweisung. deriveDecisionCode() bildet ihn zusammen mit
// den harten Kontrollsignalen (Sanktionen, kritischer Quellenausfall, Kontext-Flags)
// auf einen der sechs Entscheidungszustände aus der Phasen-Spezifikation V1.0 ab:
// ALLOW / ASK / HOLD / MANUAL_REVIEW / REJECT / ERROR.
//
// Reihenfolge = Priorität. Die erste zutreffende Regel entscheidet; alle danach
// greifenden Bedingungen werden trotzdem als zusätzliche reasonCodes gesammelt,
// damit der Decision Trail vollständig bleibt, auch wenn sie das Ergebnis nicht
// mehr verändern.
//
// MUSS vor saveToCache() aufgerufen werden — das Ergebnis wird Teil des gecachten
// Objekts und muss daher feststehen, bevor der Cache-Eintrag geschrieben wird.
// ============================================================

function deriveDecisionCode({ isSanctioned, criticalSourceOutage, context, aiResult, aiAnalysisFailed, coverageRatio, travelRuleStatus, esmaCheck, scam }) {
  const reasonCodes = [];
  let decisionCode = null;

  const isSupportLeakContext = SUPPORT_LEAK_CONTEXT_VALUES.has(context);
  const level = aiResult.riskLevel;
  // GA-13: Clearifyer erzeugt niemals eigene TFR-Daten — der Status kommt vom
  // Kunden-/Partnersystem (siehe E2E-Playbook, Phase D "Travel Rule status").
  // "missing"/"failed" sind die beiden Zustände, bei denen die Pflichtangabe
  // fehlt oder nicht zugestellt werden konnte; "available"/"pending" lösen
  // keine Regel aus (pending ist ein normaler Zwischenzustand, kein Blocker).
  const isTravelRuleIncomplete = travelRuleStatus === "missing" || travelRuleStatus === "failed";

  // Alle zutreffenden Signale sammeln (für Evidence/Reason-Codes),
  // unabhängig davon, welches am Ende die Entscheidung bestimmt.
  if (isSanctioned)              reasonCodes.push("SANCTIONS_HIT");
  if (criticalSourceOutage)      reasonCodes.push("CRITICAL_SOURCE_UNAVAILABLE");
  if (isSupportLeakContext)      reasonCodes.push("CONTEXT_SUPPORT_IMPERSONATION");
  if (level === "KRITISCH")      reasonCodes.push("RISK_CRITICAL");
  if (level === "HOCH")          reasonCodes.push("RISK_HIGH");
  if (level === "MITTEL")        reasonCodes.push("RISK_MEDIUM");
  if (isTravelRuleIncomplete)    reasonCodes.push("TRAVEL_RULE_DATA_" + travelRuleStatus.toUpperCase());
  const counterpartyFlagged = esmaCheck?.available && esmaCheck.matches?.length > 0;
  if (counterpartyFlagged) reasonCodes.push("COUNTERPARTY_UNLICENSED");
  const scamConfirmed = scam?.code === "SCAM_ADDRESS_CONFIRMED";
  const scamReported  = scam?.code === "SCAM_ADDRESS_REPORTED";
  if (scamConfirmed) reasonCodes.push("SCAM_ADDRESS_CONFIRMED");
  if (scamReported)  reasonCodes.push("SCAM_ADDRESS_REPORTED");
  if (aiAnalysisFailed)          reasonCodes.push("AI_ANALYSIS_UNAVAILABLE");
  if (coverageRatio < 0.6)       reasonCodes.push("DATA_COVERAGE_LOW");

  // Priorität 1: Sanktionstreffer — härtester Stopp, keine Ermessensfrage.
  if (isSanctioned) {
    decisionCode = "REJECT";
  }
  // Priorität 2: kritischer Quellenausfall — Fail-safe. Ein Ausfall der
  // Sanktionsprüfung darf NIE automatisch zu ALLOW führen (GA-02).
  else if (criticalSourceOutage) {
    decisionCode = "ERROR";
  }
    // Priorität 2b: Fraud-Adresse mehrfach/verifiziert gemeldet — Block bis
  // menschlicher Prüfung. Community-Quelle, daher MANUAL_REVIEW statt REJECT.
  else if (scamConfirmed) {
    decisionCode = "MANUAL_REVIEW";
  }
  // Priorität 3: Kontext-Fraud-Signal (z.B. "Support gab mir die Adresse").
  else if (isSupportLeakContext) {
    decisionCode = "MANUAL_REVIEW";
  }
  // Priorität 4: Score-Floor hat KRITISCH erzwungen, ohne dass isSanctioned
  // gesetzt war (sollte praktisch nicht vorkommen — Sicherheitsnetz).
  else if (level === "KRITISCH") {
    decisionCode = "REJECT";
  }
  // Priorität 5: Hohes Risiko ohne harten Trigger → Vier-Augen-Fall.
  else if (level === "HOCH") {
    decisionCode = "MANUAL_REVIEW";
  }
  // Priorität 5b: Fraud-Adresse einmalig/unverifiziert gemeldet — kein
  // Hard-Block, aber keine automatische Freigabe.
  else if (scamReported) {
    decisionCode = "HOLD";
  }  
  // Priorität 6 (GA-13): Pflichtangabe zum Zahlungsverkehr (Travel Rule) fehlt
  // oder konnte nicht zugestellt werden. Unabhängig vom Fraud-/AML-Risiko der
  // Adresse selbst — eine sonst unauffällige Adresse darf trotzdem nicht ohne
  // vollständige TFR-Daten automatisch freigegeben werden.
  else if (isTravelRuleIncomplete) {
    decisionCode = "HOLD";
  }
    // Priorität 6b: Genannte Gegenpartei steht auf der ESMA-Non-Compliant-Liste.
  // Namens-Match = geringere Konfidenz als jedes Adress-Signal — daher ASK,
  // kein REJECT/MANUAL_REVIEW. Der Trail zeigt Behörde/Land/Grund, damit die
  // Aussage nie zu "Marke X ist verboten" verkürzt wird.
  else if (counterpartyFlagged) {
    decisionCode = "ASK";
  }
  // Priorität 7: KI-Gesamtbewertung nicht verfügbar → keine automatische
  // Freigabe; Rohdaten liegen vor, aber ein Mensch muss sie einordnen.
  else if (aiAnalysisFailed) {
    decisionCode = "HOLD";
  }
  // Priorität 8: Datenabdeckung zu niedrig, um ein Grün zu rechtfertigen,
  // auch wenn kein einzelnes Signal kritisch war.
  else if (coverageRatio < 0.6) {
    decisionCode = "ASK";
  }
  // Priorität 9: mittleres Risiko ohne harten Trigger → zusätzliche
  // Bestätigung/Information sinnvoll, aber kein Case nötig.
  else if (level === "MITTEL") {
    decisionCode = "ASK";
  }
  // Kein Trigger, volle Datenabdeckung, geringes Risiko.
  else {
    decisionCode = "ALLOW";
  }

  return { decisionCode, reasonCodes };
}

// ============================================================
// 9. AUDIT-LOG (Netlify Blobs)
// ============================================================

async function writeAuditLog(entry) {
  try {
    const store = getStore({
      name: contextualStoreName("clearifyer-audit-log"),
      siteID: process.env.NETLIFY_SITE_ID || "24815739-0429-4422-8273-c4309c9b6753",
      token: process.env.NETLIFY_TOKEN
    });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.setJSON(id, { id, timestamp: new Date().toISOString(), ...entry });
  } catch (e) {
    console.error("Audit-Log Fehler:", e.message);
  }
}

// ============================================================
// 10. CLAUDE KI-ANALYSE
// ============================================================

async function analyzeWithClaude({ addr, network, context, amount, onChain, chainabuse, formatValid, ofac, euSanctions, misttrack, iknaio }) {
  if (!ANTHROPIC_KEY) throw new Error("Kein Anthropic API-Key");

  const networkNames = {
    eth: "Ethereum", btc: "Bitcoin", bnb: "BNB Smart Chain",
    sol: "Solana", matic: "Polygon", trx: "Tron"
  };

  const prompt = `Du bist ein Krypto-Sicherheitsanalyst. Antworte NUR als valides JSON ohne Backticks oder Markdown.\n\nADRESSE: ${addr}\nNETZWERK: ${networkNames[network] || network}\nFORMAT GÜLTIG: ${formatValid}\nBETRAG: ${amount || "nicht angegeben"}\nKONTEXT: ${context || "nicht angegeben"}\n\nON-CHAIN DATEN:\n- Balance: ${onChain?.balanceEth ?? "n/a"}\n- Transaktionen gesamt: ${onChain?.txCount ?? "n/a"}\n- Erste TX: ${onChain?.firstTxDate ?? "keine"}\n- Nur Empfang: ${onChain?.receivesOnly ?? "unbekannt"}\n- Velocity (24h): ${onChain?.velocity?.detail ?? "n/a"}\n- Contract: ${onChain?.contract?.detail ?? "n/a"}\n- ERC20-Token-Transfers: ${onChain?.tokenTransfers?.available ? (() => {
        const entries = Object.entries(onChain.tokenTransfers.byToken || {}).sort((a, b) => b[1].count - a[1].count);
        const top = entries.slice(0, 3).map(([sym, d]) => `${sym}: ${d.count}x, zuletzt ${d.lastTxDate}`).join("; ");
        const rest = entries.length > 3 ? ` (+${entries.length - 3} weitere Token, hier nicht im Detail aufgeführt)` : "";
        return `${onChain.tokenTransfers.totalCount} Transfers über ${entries.length} verschiedene Token — ${top || "keine"}${rest}`;
      })() : "nicht verfügbar"}\n\nSANKTIONEN:\n- OFAC (USA): ${ofac?.detail ?? "nicht geprüft"}\n- EU-Sanktionen: ${euSanctions?.detail ?? "nicht geprüft"}\n\nAML-DATENBANKEN:\n- Chainabuse Meldungen: ${chainabuse?.reports ?? 0} ${chainabuse?.categories?.length ? "(" + chainabuse.categories.join(", ") + ")" : ""}\n- MistTrack Score: ${misttrack?.riskScore ?? "n/a"} | ${misttrack?.detail ?? "nicht geprüft"}\n- MistTrack Gegenparteien: ${misttrack?.counterpartyList?.slice(0,3).map(c => `${c.name} ${c.percent?.toFixed(0)}%`).join(", ") || "keine"}\n- MistTrack Risiko-Gegenparteien: ${misttrack?.flaggedCounterparties?.join(", ") || "keine"}\n\nGRAPHSENSE / IKNAIO ATTRIBUTION:\n- Status: ${iknaio?.available ? "verfügbar" : "nicht verfügbar"}\n- Bewertung: ${iknaio?.detail ?? "n/a"}\n- Labels: ${iknaio?.labels?.join(", ") || "keine"}\n- Konzepte: ${iknaio?.concepts?.join(", ") || "keine"}\n- Missbrauchsmeldungen: ${iknaio?.abuses?.join(", ") || "keine"}\n- Entität: ${iknaio?.entity ? `Cluster mit ${iknaio.entity.noAddresses} Adressen` : "unbekannt"}\n- Auffällige Nachbar-Entitäten: ${iknaio?.neighborFindings?.length > 0 ? `${iknaio.neighborFindings.length} gefunden — ${iknaio.neighborFindings.slice(0,3).map(n => n.abuses[0] || n.labels[0] || "unbekannt").join(", ")}` : "keine"}\n\nWICHTIG: Falls OFAC oder EU-Sanktionen einen Treffer melden, muss riskScore=100 und riskLevel="KRITISCH" sein.\nFalls Iknaio Missbrauch (abuses) meldet, erhöhe den riskScore entsprechend stark.\n\nAntworte exakt in diesem JSON-Format:\n{"riskScore":75,"riskLevel":"HOCH","summary":"Kurze Zusammenfassung","findings":[{"level":"rot","label":"Label","text":"Erklaerung"}],"recommendation":"Empfehlung auf Deutsch"}`;

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    })
  }, 15000); // 15s Budget — die KI-Analyse braucht mehr Zeit als ein einfacher Datenbank-Call

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API: HTTP ${res.status} — ${errText}`);
  }

  const data  = await res.json();
  const raw   = (data.content || []).map(b => b.text || "").join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ============================================================
// 11. HAUPTHANDLER
// ============================================================

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const start = Date.now();

  try {
 const { addr, network, context, amount, demo, tenantId, travelRuleStatus, counterpartyName } = JSON.parse(event.body || "{}");
if (!addr || !network) return { statusCode: 400, headers, body: JSON.stringify({ error: "addr und network erforderlich" }) };

// GA-09: ohne expliziten Mandanten greift der Pilot-Default (siehe Kommentar bei DEFAULT_TENANT_ID).
const resolvedTenantId = (tenantId && String(tenantId).trim()) || DEFAULT_TENANT_ID;

// GA-13: nur die vier in E2E-Playbook/Spezifikation dokumentierten Zustände sind gültig;
// alles andere (inkl. nicht gesetzt) wird wie "nicht angegeben" behandelt und
// löst keine Regel aus — Clearifyer erzeugt niemals eigene TFR-Daten.
const VALID_TRAVEL_RULE_STATUS = new Set(["available", "pending", "missing", "failed"]);
const resolvedTravelRuleStatus = VALID_TRAVEL_RULE_STATUS.has(travelRuleStatus) ? travelRuleStatus : null;

if (demo === true) {
  const normalizedAddr = addr.toLowerCase().trim();
  if (!DEMO_WHITELIST.has(normalizedAddr)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        error: "demo_restricted",
        message: "Im Demo-Modus sind nur die zwei vorgegebenen Adressen verfügbar. Für die Prüfung beliebiger Adressen: tino@clearifyer.de für Pilot-Zugang kontaktieren."
      })
    };
  }
}

    // ── ENS auflösen ────────────────────────────────────────
    const ensResult = await resolveENS(addr);
    if (ensResult.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: ensResult.error }) };
    }
    const address = ensResult.address || addr.trim();

    // ── Adressformat validieren ──────────────────────────────
    const formatCheck = validateAddress(address, network);

    // ── CACHE-LOOKUP (vor allen API-Calls) ──────────────────
    const cached = await getFromCache(address, network, context, resolvedTenantId, resolvedTravelRuleStatus, counterpartyName);
    if (cached) {
      console.log(`Cache HIT: ${resolvedTenantId}:${network}:${address}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...cached,
          cacheHit: true,
          cachedAt: cached.cachedAt,
          ensName: ensResult.ensName || cached.ensName || null,
        })
      };
    }
    console.log(`Cache MISS: ${network}:${address} — rufe externe APIs ab`);

    // ── Alle Checks parallel (inkl. Iknaio) ─────────────────
    const [onChain, chainabuse, ofac, euSanctions, misttrack, iknaio] = await Promise.all([
      fetchEtherscan(address, network),
      fetchChainabuse(address),
      checkOFAC(address),
      checkEUSanctions(address),
      checkMistTrack(address, network),
      checkIknaio(address, network),
    ]);
    // ── Phase 2, Schritt 2: Gegenpartei-Name gegen ESMA Non-Compliant prüfen ──
    const esmaCheck = await checkCounterpartyESMA(counterpartyName);
    // ── Phase 1 (nachgeholt): Fraud-Aggregation aus Chainabuse (+ CryptoScamDB, sobald aktiv) ──
    const scam = classifyScam([
      chainabuseToScamInput(chainabuse),
      await screenCryptoScamDB(address),
    ]);
   

    // ── K.O.-Kriterium: Sanktionslisten ─────────────────────
    const isSanctioned = ofac.sanctioned || euSanctions.sanctioned;
    const sanctionSource = ofac.sanctioned ? "OFAC SDN (US Treasury)" : euSanctions.sanctioned ? "EU Financial Sanctions File" : null;

    // ── Datenquellen-Status & Coverage (vor der KI-Analyse, damit transparent ist was überhaupt vorlag) ──
    const dataSourceStatus = buildDataSourceStatus({ network, onChain, chainabuse, misttrack, iknaio, ofac, euSanctions });
    const coverageRatio = calcCoverageRatio(dataSourceStatus);

    // ── GA-02: kritischer Quellenausfall ─────────────────────
    // OFAC und EU-Sanktionen sind die einzigen Quellen, deren Ausfall NIE zu einem
    // automatischen Grün führen darf (rechtliche Pflichtprüfung, keine Ermessensfrage).
    // Andere Quellen (Iknaio, MistTrack, Etherscan) fließen bereits über coverageRatio
    // in die Entscheidung ein — das reicht für sie, weil sie keine harte Sperrpflicht sind.
    const criticalSourceOutage = ofac.live !== true || euSanctions.live !== true;

    // ── KI-Analyse ───────────────────────────────────────────
    // Abgesichert: Wenn die KI-Analyse fehlschlägt oder ihr Zeitbudget überschreitet
    // (z.B. bei sehr aktiven Adressen wie großen Token-Contracts mit riesiger
    // MistTrack/Iknaio-Datenmenge), darf das NICHT als roher Fehler beim User
    // landen. Stattdessen: konservativer Fallback mit explizitem Hinweis, dass
    // die KI-Bewertung fehlte — sicherer Default ist "MITTEL", nicht "GERING".
    let rawAiResult;
    let aiAnalysisFailed = false;
    try {
      rawAiResult = await analyzeWithClaude({
        addr: address, network, context, amount,
        onChain, chainabuse, formatValid: formatCheck.valid,
        ofac, euSanctions, misttrack, iknaio
      });
    } catch (aiErr) {
      console.error("KI-Analyse fehlgeschlagen:", aiErr.message);
      aiAnalysisFailed = true;
      rawAiResult = {
        riskScore: 50,
        riskLevel: "MITTEL",
        summary: "Die automatisierte KI-Risikobewertung konnte für diese Adresse nicht abgeschlossen werden (z.B. wegen sehr hoher Datenmenge oder Zeitüberschreitung).",
        findings: [{
          level: "gelb",
          label: "KI-Analyse fehlgeschlagen",
          text: `Die KI-gestützte Gesamtbewertung war technisch nicht möglich (${aiErr.message}). Die On-Chain-, Sanktions- und AML-Rohdaten oben sind dennoch vollständig und live geprüft — bitte manuell auswerten oder erneut versuchen.`
        }],
        recommendation: "Die automatisierte Gesamtbewertung konnte nicht erstellt werden. Bitte die einzelnen Datenpunkte (Sanktionslisten, On-Chain-Daten, Chainabuse, MistTrack, Iknaio) oben manuell prüfen oder die Anfrage erneut stellen, bevor du dich auf diese Adresse verlässt."
      };
    }

    // ── Harte Score-Floors: Code-Override, KI-Output ist nur ein Vorschlag ──
    const aiResult = applyScoreFloors({
      aiResult: rawAiResult,
      isSanctioned, sanctionSource,
      iknaio, misttrack, context,
      coverageRatio,
    });
    aiResult.aiAnalysisFailed = aiAnalysisFailed;

    // ── GA-03: Decision Code ableiten ─────────────────────────
    // MUSS hier stehen: nach den Score-Floors (damit riskLevel final ist),
    // aber vor writeAuditLog() und vor der result-Zusammenstellung/saveToCache()
    // (damit sowohl Audit-Log als auch Cache-Eintrag den Decision Code enthalten
    // und nicht aus dem Score nachträglich rekonstruiert werden müssen).
    const { decisionCode, reasonCodes } = deriveDecisionCode({
      isSanctioned, criticalSourceOutage, context,
      aiResult, aiAnalysisFailed, coverageRatio,
      travelRuleStatus: resolvedTravelRuleStatus,
      esmaCheck, scam,
    });

    // ── Audit-Log schreiben ──────────────────────────────────
    await writeAuditLog({
      // GA-09 (schlank): tenant_id ab sofort in jedem Audit-Eintrag, damit Filterung
      // nach Mandant (siehe C-03) später ohne Nacherfassung alter Daten möglich ist.
      tenant_id: resolvedTenantId,
      address,
      ens_name: ensResult.ensName || null,
      chain: network,
      context_answer: context || "–",
      counterparty_name: counterpartyName || null,
      esma_counterparty_checked: esmaCheck.checked,
      esma_counterparty_available: esmaCheck.available,
      esma_counterparty_matches: esmaCheck.matches.map(m => ({
        matchedName: m.matchedName,
        authority: m.competentAuthority,
        country: m.homeMemberState,
        reason: m.reason,
      })),
      scam_confidence: scam.code,
      scam_sources: scam.reportingSources,
      scam_report_count: scam.reportCount,
      // GA-13: null, falls vom Kunden/Partnersystem nicht mitgeliefert — Clearifyer
      // erzeugt niemals eigene TFR-Daten, daher kein Default außer "nicht angegeben".
      travel_rule_status: resolvedTravelRuleStatus,
      risk_score_raw_ai: rawAiResult.riskScore,
      risk_score_final: aiResult.riskScore,
      risk_level: aiResult.riskLevel,
      score_overridden: aiResult.scoreOverridden,
      applied_floors: aiResult.appliedFloors,
      sanctioned: isSanctioned,
      sanction_source: sanctionSource,
      // GA-02/GA-03: Quellenausfall und resultierender Decision Code gehören ins
      // Audit-Log — sonst ist im Nachhinein nicht rekonstruierbar, ob ein ERROR/HOLD
      // durch Risiko oder durch einen Ausfall der Sanktionsprüfung ausgelöst wurde.
      critical_source_outage: criticalSourceOutage,
      decision_code: decisionCode,
      reason_codes: reasonCodes,
      iknaio_risk: iknaio.risk,
      iknaio_labels: iknaio.labels || [],
      iknaio_neighbors_flagged: (iknaio.neighborFindings || []).length,
      data_source_status: dataSourceStatus,
      coverage_ratio: coverageRatio,
      sources_checked: ["OFAC", "EU", "Chainabuse", "MistTrack", "Etherscan", "Iknaio"],
      cache_hit: false,
      duration_ms: Date.now() - start,
    });

    // ── Ergebnis zusammenstellen ─────────────────────────────
    const result = {
      tenantId: resolvedTenantId,
      travelRuleStatus: resolvedTravelRuleStatus,
      addr: address,
      ensName: ensResult.ensName || null,
      network,
      formatValid: formatCheck.valid,
      onChain,
      chainabuse,
      ofac,
      euSanctions,
      misttrack,
      iknaio: {
        available: iknaio.available,
        risk: iknaio.risk,
        detail: iknaio.detail,
        labels: iknaio.labels,
        concepts: iknaio.concepts,
        abuses: iknaio.abuses,
        neighborFindings: (iknaio.neighborFindings || []).map(n => ({
          labels: n.labels,
          abuses: n.abuses,
        })),
        entitySize: iknaio.entity?.noAddresses ?? null,
        totalTxs: iknaio.totalTxs,
        firstTx: iknaio.firstTx,
        lastTx: iknaio.lastTx,
      },
      sanctioned: isSanctioned,
      sanctionSource,
      dataSourceStatus,
      coverageRatio,
      criticalSourceOutage,
      // GA-03: decisionCode/reasonCodes sind Teil von "result" und werden damit
      // automatisch von saveToCache() persistiert — ein Cache-HIT liefert denselben
      // Decision Code zurück wie die ursprüngliche Live-Prüfung, ohne ihn erneut
      // berechnen zu müssen.
      decisionCode,
      reasonCodes,
      checkedAt: new Date().toLocaleDateString("de-DE"),
      ...aiResult,
      vasp: lookupVASP(address),
      counterpartyName: counterpartyName || null,
     esmaCheck,
      scam,
      cacheHit: false,
    };

    // ── Ergebnis in Cache speichern ──────────────────────────
    await saveToCache(address, network, context, resolvedTenantId, resolvedTravelRuleStatus, counterpartyName, result);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Zusätzliche Exports für Unit-/Regressionstests (test-floors.js) ──
// Ändert das Verhalten der Netlify Function nicht — exports.handler bleibt
// der Entry Point, der Rest sind benannte Exports für lokale Tests.
exports.applyScoreFloors = applyScoreFloors;
exports.buildDataSourceStatus = buildDataSourceStatus;
exports.calcCoverageRatio = calcCoverageRatio;
exports.CHAIN_SOURCE_SUPPORT = CHAIN_SOURCE_SUPPORT;
exports.deriveDecisionCode = deriveDecisionCode;
