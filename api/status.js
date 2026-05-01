// Vercel Serverless Function — citire status abonament din Airtable (READ-ONLY, public prin cod unic)
// Tokenul Airtable este pastrat ca variabila de mediu AIRTABLE_TOKEN si nu ajunge niciodata in browser.
//
// STRUCTURA AIRTABLE NECESARA — tabel `UtilizareAbonamente`:
//   - Cod client (Single line text) — cod unic per client (ex: "MAIA01", "ABC123"); este "cheia" cu care clientul vede statusul
//   - Nume client (Single line text)
//   - Tip pachet (Single select: "Silver Câine", "Silver Pisică", etc.)
//   - Data start (Date)
//   - Data expirare (Date) — recomandat: formula = DATEADD({Data start}, 1, 'years')
//   - Consultatie folosita (Checkbox)
//   - Data consultatie (Date)
//   - Vaccin folosit (Checkbox)
//   - Data vaccin (Date)
//   - Deparazitari interne folosite (Number, integer, default 0)
//   - Deparazitari externe folosite (Number, integer, default 0)
//   - Urgenta folosita (Checkbox)
//   - Data urgenta (Date)
//   - Note (Long text, optional)

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'UtilizareAbonamente';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server misconfigured: missing AIRTABLE_TOKEN' });
  }

  const cod = (req.query.cod || '').toString().trim();
  // Validare format: 4-16 caractere alfanumerice
  if (!cod || !/^[A-Za-z0-9_-]{4,16}$/.test(cod)) {
    return res.status(400).json({ error: 'Cod invalid' });
  }

  // Escapare pentru filterByFormula (Airtable accepta ghilimele simple in valori cu escape)
  const escaped = cod.replace(/'/g, "\\'");
  const formula = `UPPER({Cod client})=UPPER('${escaped}')`;
  const url = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(TABLE)
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&maxRecords=1';

  try {
    const airtableRes = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });

    const text = await airtableRes.text();
    if (!airtableRes.ok) {
      return res.status(airtableRes.status).json({ error: 'Airtable error', detail: text.slice(0, 300) });
    }

    const data = JSON.parse(text);
    const record = (data.records && data.records[0]) || null;
    if (!record) {
      return res.status(404).json({ error: 'Cod inexistent' });
    }

    const f = record.fields || {};
    // Returnam doar campurile necesare pentru afisare (sanitized)
    return res.status(200).json({
      cod: f['Cod client'] || cod,
      nume: f['Nume client'] || '',
      pachet: f['Tip pachet'] || '',
      dataStart: f['Data start'] || null,
      dataExpirare: f['Data expirare'] || null,
      consultatie: {
        folosita: !!f['Consultatie folosita'],
        data: f['Data consultatie'] || null,
      },
      vaccin: {
        folosit: !!f['Vaccin folosit'],
        data: f['Data vaccin'] || null,
      },
      deparazitariInterne: {
        folosite: Number(f['Deparazitari interne folosite'] || 0),
        total: 2,
      },
      deparazitariExterne: {
        folosite: Number(f['Deparazitari externe folosite'] || 0),
        total: 4,
      },
      urgenta: {
        folosita: !!f['Urgenta folosita'],
        data: f['Data urgenta'] || null,
      },
      note: f['Note'] || '',
    });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
