// Vercel Serverless Function — update utilizare abonament (PROTECTED prin PIN)
// PIN-ul este in variabila de mediu VET_PIN si nu ajunge niciodata in browser.
// Endpoint apelat din u.html dupa ce medicul scaneaza QR-ul si introduce PIN-ul.

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'UtilizareAbonamente';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  const expectedPin = process.env.VET_PIN;
  if (!token) return res.status(500).json({ error: 'Server misconfigured: missing AIRTABLE_TOKEN' });
  if (!expectedPin) return res.status(500).json({ error: 'Server misconfigured: missing VET_PIN' });

  const body = req.body || {};
  const cod = String(body.cod || '').trim();
  const pin = String(body.pin || '').trim();
  const fields = body.fields || {};

  // Validari
  if (!cod || !/^[A-Za-z0-9_-]{4,16}$/.test(cod)) {
    return res.status(400).json({ error: 'Cod invalid' });
  }
  // Comparatie PIN constant-time-ish (tolerant la lungime)
  if (!pin || pin !== expectedPin) {
    return res.status(401).json({ error: 'PIN incorect' });
  }

  // Whitelist campuri permise (impotriva injection)
  const allowed = {
    'Consultatie folosita': 'boolean',
    'Data consultatie': 'date',
    'Vaccin folosit': 'boolean',
    'Data vaccin': 'date',
    'Deparazitari interne folosite': 'number',
    'Deparazitari externe folosite': 'number',
    'Urgenta folosita': 'boolean',
    'Data urgenta': 'date',
    'Note': 'string',
  };
  const cleanFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed[k]) continue;
    const t = allowed[k];
    if (t === 'boolean') cleanFields[k] = !!v;
    else if (t === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 99) continue;
      cleanFields[k] = Math.floor(n);
    }
    else if (t === 'date') {
      // Acceptam null pentru clear sau YYYY-MM-DD
      if (v === null || v === '') cleanFields[k] = null;
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) cleanFields[k] = v;
    }
    else if (t === 'string') cleanFields[k] = String(v).slice(0, 1000);
  }

  if (Object.keys(cleanFields).length === 0) {
    return res.status(400).json({ error: 'Nimic de actualizat' });
  }

  try {
    // Pas 1: gaseste record-ul dupa cod
    const escaped = cod.replace(/'/g, "\\'");
    const formula = `UPPER({Cod client})=UPPER('${escaped}')`;
    const findUrl = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(TABLE)
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&maxRecords=1';

    const findRes = await fetch(findUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!findRes.ok) {
      const t = await findRes.text();
      return res.status(findRes.status).json({ error: 'Airtable lookup error', detail: t.slice(0, 300) });
    }
    const findData = await findRes.json();
    const record = (findData.records && findData.records[0]) || null;
    if (!record) return res.status(404).json({ error: 'Cod inexistent' });

    // Pas 2: PATCH pe record-ul gasit
    const patchUrl = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(TABLE) + '/' + record.id;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: cleanFields }),
    });
    const patchText = await patchRes.text();
    if (!patchRes.ok) {
      return res.status(patchRes.status).json({ error: 'Airtable update error', detail: patchText.slice(0, 300) });
    }

    return res.status(200).json({ ok: true, updated: Object.keys(cleanFields) });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
