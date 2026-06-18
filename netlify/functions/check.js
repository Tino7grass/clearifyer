// netlify/functions/check.js
// Clearifyer — API Aggregator
// Quellen: Etherscan + Chainabuse (optional) + Claude AI

const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY  || "";
const CHAINABUSE_KEY = process.env.CHAINABUSE_API_KEY || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";

// ── Adressformat-Validierung ─────────────────────────────────────────────────
function validateAddress(addr, network) {
  const patterns = {
    eth:   /^0x[0-9a-fA-F]{40}$/,
    bnb:   /^0x[0-9a-fA-F]{40}$/,
    matic: /^0x[0-9a-fA-F]{40}$/,
    btc:   /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$|^bc1[0-9a-z]{6,87}$/,
    sol:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    trx:   /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  };
  if (!patterns[network]) return { valid: true, note: "Format unbekannt" };
  return { valid: patterns[network].test(addr) };
}

// ── Etherscan: On-Chain Daten ────────────────────────────────────────────────
async function fetchEtherscan(addr, network) {
  const chainIds = { eth: 1, bnb: 56, matic: 137 };
  const chainId  = chainIds[network];
  if (!chainId) return { skipped: true, reason: "Netzwerk nicht unterstützt" };
  if (!ETHERSCAN_KEY) return { skipped: true, reason: "Kein API-Key" };

  try {
    const base = `https://api.etherscan.io/v2/api?chainid=${chainId}&apikey=${ETHERSCAN_KEY}`;
    const [balRes, txRes] = await Promise.all([
      fetch(`${base}&module=account&action=balance&address=${addr}&tag=latest`),
      fetch(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=latest&page=1&offset=10&sort=asc`)
    ]);

    const balData = await balRes.json();
    const txData  = await txRes.json();

    const balanceEth = balData.status === "1"
      ? (parseFloat(balData.result) / 1e18).toFixed(6)
      : null;

    let txCount = 0, firstTxDate = null, lastTxDate = null, receivesOnly = false;

    if (txData.status === "1" && Array.isArray(txData.result) && txData.result.length > 0) {
      txCount = txData.result.length;
      firstTxDate = new Date(parseInt(txData.result[0].timeStamp) * 1000)
        .toLocaleDateString("de-DE");
      lastTxDate = new Date(parseInt(txData.result[txData.result.length - 1].timeStamp) * 1000)
        .toLocaleDateString("de-DE");
      receivesOnly = txData.result.every(tx =>
        tx.to?.toLowerCase() === addr.toLowerCase()
      );
    }

    return { balanceEth, txCount, firstTxDate, lastTxDate, receivesOnly };

  } catch (e) {
    return { error: e.message };
  }
}

// ── Chainabuse: Scam-Reports ─────────────────────────────────────────────────
async function fetchChainabuse(addr) {
  if (!CHAINABUSE_KEY) return { reports: 0, note: "Kein API-Key — Free Tier" };
  try {
    const res = await fetch(
      `https://www.chainabuse.com/api/reports/search?address=${encodeURIComponent(addr)}`,
      { headers: { "X-API-Key": CHAINABUSE_KEY } }
    );
    if (!res.ok) return { reports: 0, note: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      reports:    data.totalCount ?? 0,
      categories: [...new Set((data.reports || []).map(r => r.scamCategory).filter(Boolean))]
    };
  } catch (e) {
    return { reports: 0, note: e.message };
  }
}

// ── Claude AI: Analyse ───────────────────────────────────────────────────────
async function analyzeWithClaude({ addr, network, context, amount, onChain, chainabuse, formatValid }) {
  if (!ANTHROPIC_KEY) throw new Error("Kein Anthropic API-Key konfiguriert");

  const networkNames = {
    eth: "Ethereum", btc: "Bitcoin", bnb: "BNB Smart Chain",
    sol: "Solana", matic: "Polygon", trx: "Tron"
  };

  const prompt = `Du bist ein Krypto-Sicherheitsanalyst. Antworte NUR als valides JSON ohne Markdown-Backticks.

ADRESSE: ${addr}
NETZWERK: ${networkNames[network] || network}
FORMAT GÜLTIG: ${formatValid}
BETRAG: ${amount || "nicht angegeben"}
KONTEXT: ${context || "nicht angegeben"}

ON-CHAIN DATEN (Etherscan):
- Kontostand: ${onChain?.balanceEth ?? "n/a"} ETH
- Transaktionen (erste 10): ${onChain?.txCount ?? "n/a"}
- Erste TX: ${onChain?.firstTxDate ?? "keine"}
- Letzte TX: ${onChain?.lastTxDate ?? "keine"}
- Nur Empfänger: ${onChain?.receivesOnly ?? "unbekannt"}

CHAINABUSE:
- Gemeldete Scams: ${chainabuse?.reports ?? 0}
- Kategorien: ${chainabuse?.categories?.join(", ") || "keine"}

Bewerte alle verfügbaren Signale und antworte als JSON:
{
  "riskScore": 0-100,
  "riskLevel": "NIEDRIG"|"MITTEL"|"HOCH"|"SEHR HOCH",
  "summary": "Ein klarer Satz auf Deutsch",
  "findings": [
    {"level":"rot"|"gelb"|"gruen"|"blau","label":"Kurzes Label","text":"Erklärung auf Deutsch"}
  ],
  "recommendation": "Konkrete Handlungsempfehlung auf Deutsch"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status}`);
  const data = await res.json();
  const raw  = (data.content || []).map(b => b.text || "").join("").trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { addr, network, context, amount } = JSON.parse(event.body || "{}");

    if (!addr || !network) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({ error: "addr und network sind erforderlich" })
      };
    }

    const address = addr.trim();

    // Alle Quellen parallel abfragen
    const formatCheck = validateAddress(address, network);
    const [onChain, chainabuse] = await Promise.all([
      fetchEtherscan(address, network),
      fetchChainabuse(address)
    ]);

    // KI-Analyse
    const aiResult = await analyzeWithClaude({
      addr: address, network, context, amount,
      onChain, chainabuse,
      formatValid: formatCheck.valid
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        addr: address,
        network,
        formatValid: formatCheck.valid,
        onChain,
        chainabuse,
        checkedAt: new Date().toLocaleDateString("de-DE"),
        ...aiResult
      })
    };

  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
