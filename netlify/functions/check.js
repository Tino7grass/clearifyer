// netlify/functions/check.js
// Clearifyer — API Aggregator v2.0
// Neu: OFAC, EU-Sanktionen, ENS-Auflösung, Velocity Check,
//      Contract Detection, Multi-Chain, MistTrack, Audit-Log

const { getStore } = require("@netlify/blobs");

const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY  || "";
const CHAINABUSE_KEY = process.env.CHAINABUSE_API_KEY || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const MISTTRACK_KEY  = process.env.MISTTRACK_API_KEY  || "";

// ── Cache für Sanktionslisten (1h TTL) ──────────────────────
let _ofacAddresses = null, _ofacTs = 0;
let _euAddresses   = null, _euTs   = 0;
const CACHE_TTL = 60 * 60 * 1000;

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
    // Etherscan ENS-Lookup
    const res = await fetch(
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
// 3. OFAC SDN LIST
// ============================================================

async function loadOFAC() {
  if (_ofacAddresses && Date.now() - _ofacTs < CACHE_TTL) return _ofacAddresses;
  try {
    const res = await fetch("https://www.treasury.gov/ofac/downloads/sdn.csv");
    if (!res.ok) return new Set();
    const text = await res.text();
    const matches = text.match(/0x[a-fA-F0-9]{40}/g) || [];
    _ofacAddresses = new Set(matches.map(a => a.toLowerCase()));
    _ofacTs = Date.now();
    return _ofacAddresses;
  } catch { return new Set(); }
}

async function checkOFAC(address) {
  const set = await loadOFAC();
  const sanctioned = set.has(address.toLowerCase());
  return {
    sanctioned,
    risk: sanctioned ? "critical" : "clear",
    detail: sanctioned
      ? "⛔ Adresse steht auf der US-Sanktionsliste (OFAC SDN). Transaktion rechtlich verboten."
      : "✅ Nicht auf der OFAC SDN-Liste gefunden."
  };
}

// ============================================================
// 4. EU-SANKTIONSLISTEN
// ============================================================

async function loadEU() {
  if (_euAddresses && Date.now() - _euTs < CACHE_TTL) return _euAddresses;
  try {
    const res = await fetch(
      "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content"
    );
    if (!res.ok) return new Set();
    const xml = await res.text();
    const matches = xml.match(/0x[a-fA-F0-9]{40}/g) || [];
    _euAddresses = new Set(matches.map(a => a.toLowerCase()));
    _euTs = Date.now();
    return _euAddresses;
  } catch { return new Set(); }
}

async function checkEUSanctions(address) {
  const set = await loadEU();
  const sanctioned = set.has(address.toLowerCase());
  return {
    sanctioned,
    risk: sanctioned ? "critical" : "clear",
    detail: sanctioned
      ? "⛔ Adresse steht auf der EU-Sanktionsliste. Transaktion verstößt gegen EU-Recht."
      : "✅ Nicht auf der EU-Sanktionsliste gefunden."
  };
}

// ============================================================
// 5. ETHERSCAN (bestehend, erweitert um Velocity + Contract)
// ============================================================

async function fetchEtherscan(addr, network) {
  const chainIds = { eth: 1, bnb: 56, matic: 137 };
  const chainId  = chainIds[network];
  if (!chainId || !ETHERSCAN_KEY) return { skipped: true };

  try {
    const base = `https://api.etherscan.io/v2/api?chainid=${chainId}&apikey=${ETHERSCAN_KEY}`;
    // Transaktionen: asc für erste TX, desc für Velocity
    const [balRes, txAscRes, txDescRes, codeRes] = await Promise.all([
      fetch(`${base}&module=account&action=balance&address=${addr}&tag=latest`),
      fetch(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=1&sort=asc`),
      fetch(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=100&sort=desc`),
      fetch(`${base}&module=proxy&action=eth_getCode&address=${addr}&tag=latest`)
    ]);

    const balData   = await balRes.json();
    const txAscData = await txAscRes.json();
    const txDescData = await txDescRes.json();
    const codeData  = await codeRes.json();

    // Balance
    const balanceEth = balData.status === "1"
      ? (parseFloat(balData.result) / 1e18).toFixed(6) : null;

    // Transaktionen
    let txCount = 0, firstTxDate = null, lastTxDate = null, receivesOnly = false, velocity24h = 0;
    const now = Math.floor(Date.now() / 1000);

    // Erste TX (asc)
    if (txAscData.status === "1" && Array.isArray(txAscData.result) && txAscData.result.length > 0) {
      firstTxDate = new Date(parseInt(txAscData.result[0].timeStamp) * 1000).toLocaleDateString("de-DE");
    }

    // Neueste TXs (desc) für Velocity + letzte TX
    if (txDescData.status === "1" && Array.isArray(txDescData.result) && txDescData.result.length > 0) {
      const txs = txDescData.result;
      txCount   = txs.length;
      lastTxDate = new Date(parseInt(txs[0].timeStamp) * 1000).toLocaleDateString("de-DE");
      receivesOnly = txs.every(tx => tx.to?.toLowerCase() === addr.toLowerCase());
      velocity24h  = txs.filter(tx => parseInt(tx.timeStamp) > now - 86400).length;
    }

    // Velocity Risiko
    let velocityRisk = "low";
    let velocityDetail = `${velocity24h} Transaktion(en) in den letzten 24h — unauffällig.`;
    if (velocity24h > 20)     { velocityRisk = "high";   velocityDetail = `🚨 ${velocity24h} Transaktionen in 24h — möglicher Mixer/Tumbler.`; }
    else if (velocity24h > 5) { velocityRisk = "medium"; velocityDetail = `⚠️ ${velocity24h} Transaktionen in 24h — erhöhte Aktivität.`; }

    // Contract Detection — nur wenn Bytecode eindeutig vorhanden (mind. 100 Zeichen)
    const bytecode = codeData.result;
    const isContract = typeof bytecode === "string" && bytecode !== "0x" && bytecode !== "" && bytecode.length > 100;
    let contractRisk = "neutral";
    let contractDetail = "✅ Normale Wallet-Adresse (kein Smart Contract).";

    if (isContract) {
      try {
        const srcRes  = await fetch(`${base}&module=contract&action=getsourcecode&address=${addr}`);
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
      contract: { isContract, risk: contractRisk, detail: contractDetail }
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// 6. CHAINABUSE (bestehend, unverändert)
// ============================================================

async function fetchChainabuse(addr) {
  if (!CHAINABUSE_KEY) return { reports: 0 };
  try {
    const res = await fetch(
      `https://www.chainabuse.com/api/reports/search?address=${encodeURIComponent(addr)}`,
      { headers: { "X-API-Key": CHAINABUSE_KEY } }
    );
    if (!res.ok) return { reports: 0 };
    const data = await res.json();
    return {
      reports: data.totalCount ?? 0,
      categories: [...new Set((data.reports || []).map(r => r.scamCategory).filter(Boolean))]
    };
  } catch { return { reports: 0 }; }
}

// ============================================================
// 7. MISTTRACK AML
// ============================================================

async function checkMistTrack(address, network) {
  if (!MISTTRACK_KEY) return { available: false, detail: "MistTrack nicht konfiguriert.", risk: "unknown" };

  const chainMap = { eth: "ETH", btc: "BTC", trx: "TRX", bnb: "BNB", matic: "MATIC" };
  const coin = chainMap[network] || "ETH";

  try {
    const [labelRes, riskRes] = await Promise.all([
      fetch("https://openapi.misttrack.io/v1/address_labels", {
        method: "POST",
        headers: { "Content-Type": "application/json", "API-Key": MISTTRACK_KEY },
        body: JSON.stringify({ address, coin })
      }),
      fetch("https://openapi.misttrack.io/v1/risk_score", {
        method: "POST",
        headers: { "Content-Type": "application/json", "API-Key": MISTTRACK_KEY },
        body: JSON.stringify({ address, coin })
      })
    ]);

    const labelData = await labelRes.json();
    const riskData  = await riskRes.json();

    const labels    = labelData.data?.label_list || [];
    const riskScore = riskData.data?.score ?? null;

    const dangerous = ["mixer","tumbler","darknet","scam","phishing","ransomware","hack"];
    const safe      = ["exchange","defi","binance","coinbase","kraken"];

    let risk = "low", detail = "";
    if (labels.some(l => dangerous.some(d => l.toLowerCase().includes(d))) || (riskScore !== null && riskScore >= 70)) {
      risk   = "high";
      detail = `🚨 MistTrack: Hohes Risiko (Score: ${riskScore ?? "N/A"}). Labels: ${labels.join(", ") || "keine"}.`;
    } else if (riskScore !== null && riskScore >= 40) {
      risk   = "medium";
      detail = `⚠️ MistTrack: Erhöhtes Risiko (Score: ${riskScore}). Labels: ${labels.join(", ") || "keine"}.`;
    } else if (labels.some(l => safe.some(s => l.toLowerCase().includes(s)))) {
      risk   = "low";
      detail = `✅ MistTrack: Bekannte vertrauenswürdige Entität. Labels: ${labels.join(", ")}.`;
    } else {
      risk   = "neutral";
      detail = `MistTrack: Keine auffälligen Labels (Score: ${riskScore ?? "N/A"}).`;
    }

    return { available: true, riskScore, labels, risk, detail };
  } catch (e) {
    return { available: false, risk: "unknown", detail: "MistTrack vorübergehend nicht verfügbar." };
  }
}

// ============================================================
// 8. AUDIT-LOG (Netlify Blobs)
// ============================================================

async function writeAuditLog(entry) {
  try {
    const store = getStore({
      name: "clearifyer-audit-log",
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
// 9. CLAUDE KI-ANALYSE (erweitert)
// ============================================================

async function analyzeWithClaude({ addr, network, context, amount, onChain, chainabuse, formatValid, ofac, euSanctions, misttrack }) {
  if (!ANTHROPIC_KEY) throw new Error("Kein Anthropic API-Key");

  const networkNames = {
    eth: "Ethereum", btc: "Bitcoin", bnb: "BNB Smart Chain",
    sol: "Solana", matic: "Polygon", trx: "Tron"
  };

  const prompt = `Du bist ein Krypto-Sicherheitsanalyst. Antworte NUR als valides JSON ohne Backticks oder Markdown.

ADRESSE: ${addr}
NETZWERK: ${networkNames[network] || network}
FORMAT GÜLTIG: ${formatValid}
BETRAG: ${amount || "nicht angegeben"}
KONTEXT: ${context || "nicht angegeben"}

ON-CHAIN DATEN:
- Balance: ${onChain?.balanceEth ?? "n/a"}
- Transaktionen gesamt: ${onChain?.txCount ?? "n/a"}
- Erste TX: ${onChain?.firstTxDate ?? "keine"}
- Nur Empfang: ${onChain?.receivesOnly ?? "unbekannt"}
- Velocity (24h): ${onChain?.velocity?.detail ?? "n/a"}
- Contract: ${onChain?.contract?.detail ?? "n/a"}

SANKTIONEN:
- OFAC (USA): ${ofac?.detail ?? "nicht geprüft"}
- EU-Sanktionen: ${euSanctions?.detail ?? "nicht geprüft"}

AML-DATENBANKEN:
- Chainabuse Meldungen: ${chainabuse?.reports ?? 0} ${chainabuse?.categories?.length ? "(" + chainabuse.categories.join(", ") + ")" : ""}
- MistTrack: ${misttrack?.detail ?? "nicht geprüft"}

WICHTIG: Falls OFAC oder EU-Sanktionen einen Treffer melden, muss riskScore=100 und riskLevel="KRITISCH" sein.

Antworte exakt in diesem JSON-Format:
{"riskScore":75,"riskLevel":"HOCH","summary":"Kurze Zusammenfassung","findings":[{"level":"rot","label":"Label","text":"Erklaerung"}],"recommendation":"Empfehlung auf Deutsch"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });

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
// 10. HAUPTHANDLER
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
    const { addr, network, context, amount } = JSON.parse(event.body || "{}");
    if (!addr || !network) return { statusCode: 400, headers, body: JSON.stringify({ error: "addr und network erforderlich" }) };

    // ── ENS auflösen ────────────────────────────────────────
    const ensResult = await resolveENS(addr);
    if (ensResult.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: ensResult.error }) };
    }
    const address = ensResult.address || addr.trim();

    // ── Adressformat validieren ──────────────────────────────
    const formatCheck = validateAddress(address, network);

    // ── Alle Checks parallel ─────────────────────────────────
    const [onChain, chainabuse, ofac, euSanctions, misttrack] = await Promise.all([
      fetchEtherscan(address, network),
      fetchChainabuse(address),
      checkOFAC(address),
      checkEUSanctions(address),
      checkMistTrack(address, network),
    ]);

    // ── K.O.-Kriterium: Sanktionslisten ─────────────────────
    const isSanctioned = ofac.sanctioned || euSanctions.sanctioned;
    const sanctionSource = ofac.sanctioned ? "OFAC SDN (US Treasury)" : euSanctions.sanctioned ? "EU Financial Sanctions File" : null;

    // ── KI-Analyse ───────────────────────────────────────────
    const aiResult = await analyzeWithClaude({
      addr: address, network, context, amount,
      onChain, chainabuse, formatValid: formatCheck.valid,
      ofac, euSanctions, misttrack
    });

    // ── Audit-Log schreiben ──────────────────────────────────
    await writeAuditLog({
      address,
      ens_name: ensResult.ensName || null,
      chain: network,
      context_answer: context || "–",
      risk_score: aiResult.riskScore,
      risk_level: aiResult.riskLevel,
      sanctioned: isSanctioned,
      sanction_source: sanctionSource,
      sources_checked: ["OFAC", "EU", "Chainabuse", "MistTrack", "Etherscan"],
      duration_ms: Date.now() - start,
    });

    // ── Antwort ──────────────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        addr: address,
        ensName: ensResult.ensName || null,
        network,
        formatValid: formatCheck.valid,
        onChain,
        chainabuse,
        ofac,
        euSanctions,
        misttrack,
        sanctioned: isSanctioned,
        sanctionSource,
        checkedAt: new Date().toLocaleDateString("de-DE"),
        ...aiResult
      })
    };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
