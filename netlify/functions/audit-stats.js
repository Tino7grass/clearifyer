// netlify/functions/audit-stats.js
// Statistiken über alle Audit-Log-Einträge
// Geschützt via x-admin-key Header
// Aufruf: GET /.netlify/functions/audit-stats
//         Header: x-admin-key: [ADMIN_KEY]

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // Auth-Prüfung
  const adminKey = event.headers["x-admin-key"] || event.headers["X-Admin-Key"];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  try {
    const store = getStore("clearifyer-audit-log");
    const { blobs } = await store.list();

    const entries = [];
    for (const blob of blobs) {
      const entry = await store.get(blob.key, { type: "json" });
      if (entry) entries.push(entry);
    }

    if (entries.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ total: 0, message: "Noch keine Prüfungen durchgeführt." })
      };
    }

    const now = Date.now();
    const last24h  = entries.filter(e => new Date(e.timestamp) > new Date(now - 86400000)).length;
    const last7d   = entries.filter(e => new Date(e.timestamp) > new Date(now - 7 * 86400000)).length;
    const last30d  = entries.filter(e => new Date(e.timestamp) > new Date(now - 30 * 86400000)).length;

    const sanctioned  = entries.filter(e => e.sanctioned).length;
    const highRisk    = entries.filter(e => e.risk_score >= 70).length;
    const mediumRisk  = entries.filter(e => e.risk_score >= 40 && e.risk_score < 70).length;
    const lowRisk     = entries.filter(e => e.risk_score < 40).length;

    const totalScore  = entries.reduce((s, e) => s + (e.risk_score || 0), 0);
    const avgScore    = Math.round(totalScore / entries.length);

    // Chain-Verteilung
    const chains = entries.reduce((acc, e) => {
      const c = e.chain || "unbekannt";
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {});

    // Kontext-Verteilung
    const contexts = entries.reduce((acc, e) => {
      const c = e.context_answer || "unbekannt";
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {});

    // Durchschnittliche Antwortzeit
    const durations = entries.filter(e => e.duration_ms).map(e => e.duration_ms);
    const avgDuration = durations.length
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : null;

    // Neueste & älteste Prüfung
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latest = entries[0]?.timestamp || null;
    const oldest = entries[entries.length - 1]?.timestamp || null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        overview: {
          total:        entries.length,
          last24h,
          last7d,
          last30d,
          latest,
          oldest
        },
        risk: {
          sanctioned,
          high:   highRisk,
          medium: mediumRisk,
          low:    lowRisk,
          avgScore
        },
        chains,
        contexts,
        performance: {
          avgDurationMs: avgDuration
        }
      })
    };

  } catch (err) {
    console.error("Audit-Stats Fehler:", err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
