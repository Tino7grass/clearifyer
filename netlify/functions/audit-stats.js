// netlify/functions/audit-stats.js
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const adminKey = event.headers["x-admin-key"] || event.headers["X-Admin-Key"];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const store = getStore({
      name: "clearifyer-audit-log",
      siteID: process.env.NETLIFY_SITE_ID || "24815739-0429-4422-8273-c4309c9b6753",
      token: process.env.NETLIFY_TOKEN
    });

    const { blobs } = await store.list();
    const entries = [];
    for (const blob of blobs) {
      const entry = await store.get(blob.key, { type: "json" });
      if (entry) entries.push(entry);
    }

    if (entries.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ total: 0, message: "Noch keine Prüfungen durchgeführt." }) };
    }

    const now = Date.now();
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const chains   = entries.reduce((acc, e) => { acc[e.chain || "?"] = (acc[e.chain || "?"] || 0) + 1; return acc; }, {});
    const contexts = entries.reduce((acc, e) => { acc[e.context_answer || "?"] = (acc[e.context_answer || "?"] || 0) + 1; return acc; }, {});
    const durations = entries.filter(e => e.duration_ms).map(e => e.duration_ms);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        overview: {
          total:    entries.length,
          last24h:  entries.filter(e => new Date(e.timestamp) > new Date(now - 86400000)).length,
          last7d:   entries.filter(e => new Date(e.timestamp) > new Date(now - 7 * 86400000)).length,
          last30d:  entries.filter(e => new Date(e.timestamp) > new Date(now - 30 * 86400000)).length,
          latest:   entries[0]?.timestamp || null,
          oldest:   entries[entries.length - 1]?.timestamp || null
        },
        risk: {
          sanctioned: entries.filter(e => e.sanctioned).length,
          high:       entries.filter(e => e.risk_score >= 70).length,
          medium:     entries.filter(e => e.risk_score >= 40 && e.risk_score < 70).length,
          low:        entries.filter(e => e.risk_score < 40).length,
          avgScore:   Math.round(entries.reduce((s, e) => s + (e.risk_score || 0), 0) / entries.length)
        },
        chains,
        contexts,
        performance: {
          avgDurationMs: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null
        }
      })
    };
  } catch (err) {
    console.error("Audit-Stats Fehler:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
