// Vercel Serverless Function — proxy spre Airtable
// Tokenul Airtable este pastrat ca variabila de mediu AIRTABLE_TOKEN si nu ajunge niciodata in browser.

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const ALLOWED_TABLES = new Set(['Programari', 'Abonamente', 'Newsletter', 'Feedback', 'UtilizareAbonamente']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server misconfigured: missing AIRTABLE_TOKEN' });
  }

  const { table, fields } = req.body || {};

  if (!table || !ALLOWED_TABLES.has(table)) {
    return res.status(400).json({ error: 'Invalid table' });
  }
  if (!fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  // Marime maxima a payload-ului (anti-abuz)
  const bodyStr = JSON.stringify(fields);
  if (bodyStr.length > 8000) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  try {
    const airtableRes = await fetch(
      'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(table),
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    );

    const text = await airtableRes.text();
    if (!airtableRes.ok) {
      return res.status(airtableRes.status).json({ error: 'Airtable error', detail: text.slice(0, 500) });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
