// netlify/functions/audit-export.js
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const adminKey = event.headers["x-admin-key"] || event.headers["X-Admin-Key"];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return { statusCode: 401, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
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

    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (entries.length === 0) {
      return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message: "Keine Einträge.", count: 0 }) };
    }

    const csvHeader = ["ID","Zeitstempel","Adresse","ENS-Name","Blockchain","Kontext","Risiko-Score","Risiko-Level","Sanktioniert","Sanktions-Quelle","Quellen","Dauer (ms)"].join(";");
    const csvRows = entries.map(e => [
      e.id || "",
      e.timestamp || "",
      e.address || "",
      e.ens_name || "",
      e.chain || "",
      '"' + (e.context_answer || "").replace(/"/g, '""') + '"',
      e.risk_score != null ? e.risk_score : "",
      e.risk_level || "",
      e.sanctioned ? "JA" : "NEIN",
      e.sanction_source || "",
      (e.sources_checked || []).join(", "),
      e.duration_ms || ""
    ].join(";"));

    const csv = [csvHeader, ...csvRows].join("\n");
    const filename = "clearifyer-audit-" + new Date().toISOString().slice(0,10) + ".csv";

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + filename + '"'
      },
      body: "\uFEFF" + csv
    };
  } catch (err) {
    console.error("Audit-Export Fehler:", err.message);
    return { statusCode: 500, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};
