// netlify/functions/check.js
// Clearifyer — API Aggregator v2.1
// Neu: Iknaio/GraphSense Integration

const { getStore } = require("@netlify/blobs");

const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY  || "";
const CHAINABUSE_KEY = process.env.CHAINABUSE_API_KEY || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const MISTTRACK_KEY  = process.env.MISTTRACK_API_KEY  || "";
const IKNAIO_KEY     = process.env.IKNAIO_API_KEY     || "";

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
// 5. ETHERSCAN
// ============================================================

async function fetchEtherscan(addr, network) {
  const chainIds = { eth: 1, bnb: 56, matic: 137 };
  const chainId  = chainIds[network];
  if (!chainId || !ETHERSCAN_KEY) return { skipped: true };

  try {
    const base = `https://api.etherscan.io/v2/api?chainid=${chainId}&apikey=${ETHERSCAN_KEY}`;
    const [balRes, txAscRes, txDescRes, codeRes] = await Promise.all([
      fetch(`${base}&module=account&action=balance&address=${addr}&tag=latest`),
      fetch(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=1&sort=asc`),
      fetch(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=100&sort=desc`),
      fetch(`${base}&module=proxy&action=eth_getCode&address=${addr}&tag=latest`)
    ]);

    const balData    = await balRes.json();
    const txAscData  = await txAscRes.json();
    const txDescData = await txDescRes.json();
    const codeData   = await codeRes.json();

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
// 6. CHAINABUSE
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
// 8. IKNAIO / GRAPHSENSE  ← NEU
// ============================================================

async function checkIknaio(address, network) {
  if (!IKNAIO_KEY) {
    return { available: false, detail: "Iknaio nicht konfiguriert.", risk: "unknown" };
  }

  // Chain-Mapping: Iknaio nutzt Kürzel wie "eth", "btc", "trx"
  const chainMap = { eth: "eth", btc: "btc", trx: "trx", bnb: "eth", matic: "eth" };
  const currency = chainMap[network] || "eth";

  const BASE = "https://api.ikna.io";
  const headers = {
    "Authorization": IKNAIO_KEY,
    "Accept": "application/json"
  };

  try {
    // Adress-Info, Tags und Nachbar-Entitäten parallel abrufen
    const [addrRes, tagsRes] = await Promise.all([
      fetch(`${BASE}/${currency}/addresses/${address}`, { headers }),
      fetch(`${BASE}/${currency}/addresses/${address}/tags`, { headers })
    ]);

    // Adress-Info auswerten
    let addrData = null;
    if (addrRes.ok) {
      addrData = await addrRes.json();
    }

    // Tags auswerten
    let tags = [];
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      tags = tagsData.address_tags || tagsData.tags || [];
    }

    // Tag-Labels extrahieren
    const labels = tags.map(t => t.label || t.category || "").filter(Boolean);
    const concepts = [...new Set(tags.map(t => t.concept || "").filter(Boolean))];
    const abuses = tags.filter(t => t.abuse).map(t => t.abuse);

    // ── Neighbor-Check: Entitäts-Nachbarn auf Risiko-Labels prüfen ──
    // Nur wenn Entität bekannt — sucht direkte Nachbar-Entitäten mit Abuse-Tags
    let neighborRisk = "neutral";
    let neighborFindings = [];

    const entityId = addrData?.entity?.entity;
    if (entityId) {
      try {
        // Nachbar-Entitäten mit Abuse-Filter abrufen (direction: both, max 20)
        const neighborRes = await fetch(
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

    // ── Risikobewertung (direkte Labels + Nachbarn) ──────────────────
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

    // Entitäts-Info
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
      neighborFindings,        // auffällige Nachbarn (für Audit-Log & Claude)
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
// 9. AUDIT-LOG (Netlify Blobs)
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
// 10. CLAUDE KI-ANALYSE (erweitert um Iknaio)
// ============================================================

async function analyzeWithClaude({ addr, network, context, amount, onChain, chainabuse, formatValid, ofac, euSanctions, misttrack, iknaio }) {
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

GRAPHSENSE / IKNAIO ATTRIBUTION:
- Status: ${iknaio?.available ? "verfügbar" : "nicht verfügbar"}
- Bewertung: ${iknaio?.detail ?? "n/a"}
- Labels: ${iknaio?.labels?.join(", ") || "keine"}
- Konzepte: ${iknaio?.concepts?.join(", ") || "keine"}
- Missbrauchsmeldungen: ${iknaio?.abuses?.join(", ") || "keine"}
- Entität: ${iknaio?.entity ? `Cluster mit ${iknaio.entity.noAddresses} Adressen` : "unbekannt"}
- Auffällige Nachbar-Entitäten: ${iknaio?.neighborFindings?.length > 0 ? `${iknaio.neighborFindings.length} gefunden — ${iknaio.neighborFindings.slice(0,3).map(n => n.abuses[0] || n.labels[0] || "unbekannt").join(", ")}` : "keine"}

WICHTIG: Falls OFAC oder EU-Sanktionen einen Treffer melden, muss riskScore=100 und riskLevel="KRITISCH" sein.
Falls Iknaio Missbrauch (abuses) meldet, erhöhe den riskScore entsprechend stark.

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

    // ── Alle Checks parallel (inkl. Iknaio) ─────────────────
    const [onChain, chainabuse, ofac, euSanctions, misttrack, iknaio] = await Promise.all([
      fetchEtherscan(address, network),
      fetchChainabuse(address),
      checkOFAC(address),
      checkEUSanctions(address),
      checkMistTrack(address, network),
      checkIknaio(address, network),
    ]);

    // ── K.O.-Kriterium: Sanktionslisten ─────────────────────
    const isSanctioned = ofac.sanctioned || euSanctions.sanctioned;
    const sanctionSource = ofac.sanctioned ? "OFAC SDN (US Treasury)" : euSanctions.sanctioned ? "EU Financial Sanctions File" : null;

    // ── KI-Analyse ───────────────────────────────────────────
    const aiResult = await analyzeWithClaude({
      addr: address, network, context, amount,
      onChain, chainabuse, formatValid: formatCheck.valid,
      ofac, euSanctions, misttrack, iknaio
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
      iknaio_risk: iknaio.risk,
      iknaio_labels: iknaio.labels || [],
      iknaio_neighbors_flagged: (iknaio.neighborFindings || []).length,
      sources_checked: ["OFAC", "EU", "Chainabuse", "MistTrack", "Etherscan", "Iknaio"],
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
        iknaio,
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
