// Vercel Serverless Function — citire status abonament din Airtable (READ-ONLY, public prin cod unic)
// Tokenul Airtable este pastrat ca variabila de mediu AIRTABLE_TOKEN si nu ajunge niciodata in browser.
//
// STRUCTURA AIRTABLE NECESARA — tabel `UtilizareAbonamente`:
//   - Cod client (Single line text) — cod unic per client (ex: "MAIA01", "ABC123"); este "cheia" cu care clientul vede statusul
//   - Nume client (Single line text)
//   - Tip pachet (Single line text: "Silver", "Gold", "Platinum")
//   - Activ (Checkbox) — setat manual de medic dupa confirmarea platii
//   - Data start (Date) — setat manual de medic
//   - Data expirare (Date) — recomandat: formula = DATEADD({Data start}, 1, 'years')
//   - Consultatie folosita (Checkbox)
//   - Data consultatie (Date)
//   - Vaccin folosit (Checkbox)
//   - Data vaccin (Date)
//   - Fractie leucemica (Checkbox) — pentru pisici, doar daca a fost aleasa
//   - Deparazitari interne folosite (Number, integer, default 0)
//   - Deparazitari externe folosite (Number, integer, default 0)
//   - Urgenta folosita (Checkbox) — Silver/Gold: 1x checkbox; Platinum: foloseste "Urgente folosite"
//   - Data urgenta (Date)
//   - Detartraj folosit (Checkbox) — Gold+
//   - Data detartraj (Date) — Gold+
//   - Ecografie folosita (Checkbox) — Gold+
//   - Data ecografie (Date) — Gold+
//   - Analize folosite (Checkbox) — Gold+
//   - Data analize (Date) — Gold+
//   - Tip profil analize (Single line text: "Bază" / "Avansat" / "Extins") — Gold+
//   - Vouchere produse folosite (Number, integer, default 0)
//   - Note (Long text, optional)
//   --- PLATINUM ONLY ---
//   - Vaccin tuse canisa folosit (Checkbox)
//   - Data vaccin tuse (Date)
//   - A 2-a consultatie folosita (Checkbox)
//   - Data a 2-a consultatie (Date)
//   - Consultatie specialitate folosita (Checkbox)
//   - Data consultatie specialitate (Date)
//   - A 2-a ecografie folosita (Checkbox)
//   - Data a 2-a ecografie (Date)
//   - Urgente folosite (Number, integer 0-4) — inlocuieste "Urgenta folosita" la Platinum
//   - Anestezie detartraj folosita (Checkbox)
//   - Data anestezie detartraj (Date)

import { rateLimit } from './_security.js';

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'UtilizareAbonamente';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!rateLimit(req, res, 'status', { max: 30, windowMs: 15 * 60 * 1000 })) return;

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server misconfigured: missing AIRTABLE_TOKEN' });
  }

  const cod = (req.query.cod || '').toString().trim();
  // Validare format: 4-16 caractere alfanumerice
  if (!cod || !/^[A-Za-z0-9_-]{4,32}$/.test(cod)) {
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
      console.error('[status] airtable error', airtableRes.status, text.slice(0, 300));
      return res.status(airtableRes.status).json({ error: 'Airtable error' });
    }

    const data = JSON.parse(text);
    const record = (data.records && data.records[0]) || null;
    if (!record) {
      return res.status(404).json({ error: 'Cod inexistent' });
    }

    const f = record.fields || {};
    const pachet = (f['Tip pachet'] || '').toString();
    const isGold = /gold/i.test(pachet);
    const isPlatinum = /platinum/i.test(pachet);
    const isGoldOrPlatinum = isGold || isPlatinum;

    // Returnam doar campurile necesare pentru afisare (sanitized)
    return res.status(200).json({
      cod: f['Cod client'] || cod,
      nume: f['Nume client'] || '',
      pachet: pachet,
      activ: !!f['Activ'],
      dataStart: f['Data start'] || null,
      dataExpirare: f['Data expirare'] || null,
      consultatie: {
        folosita: !!f['Consultatie folosita'],
        data: f['Data consultatie'] || null,
        total: isPlatinum ? 2 : 1,
      },
      vaccin: {
        folosit: !!f['Vaccin folosit'],
        data: f['Data vaccin'] || null,
        fractieLeucemica: !!f['Fractie leucemica'],
      },
      deparazitariInterne: {
        folosite: Number(f['Deparazitari interne folosite'] || 0),
        total: isPlatinum ? 4 : isGold ? 4 : 2,
      },
      deparazitariExterne: {
        folosite: Number(f['Deparazitari externe folosite'] || 0),
        total: isPlatinum ? 12 : isGold ? 8 : 4,
      },
      urgenta: isPlatinum ? null : {
        folosita: !!f['Urgenta folosita'],
        data: f['Data urgenta'] || null,
      },
      urgente: isPlatinum ? {
        folosite: Number(f['Urgente folosite'] || 0),
        total: 4,
        data: f['Data urgenta'] || null,
      } : null,
      detartraj: isGoldOrPlatinum ? {
        folosit: !!f['Detartraj folosit'],
        data: f['Data detartraj'] || null,
        anestezie: isPlatinum ? {
          folosita: !!f['Anestezie detartraj folosita'],
          data: f['Data anestezie detartraj'] || null,
        } : null,
      } : null,
      ecografie: isGoldOrPlatinum ? {
        folosita: !!f['Ecografie folosita'],
        data: f['Data ecografie'] || null,
        a2a: isPlatinum ? {
          folosita: !!f['A 2-a ecografie folosita'],
          data: f['Data a 2-a ecografie'] || null,
        } : null,
      } : null,
      analize: isGoldOrPlatinum ? {
        folosite: !!f['Analize folosite'],
        data: f['Data analize'] || null,
        tipProfil: f['Tip profil analize'] || '',
      } : null,
      vouchereProduse: {
        folosite: Number(f['Vouchere produse folosite'] || 0),
        total: isPlatinum ? 12 : isGold ? 8 : 5,
        discount: isPlatinum ? 12 : isGold ? 8 : 5,
      },
      // Platinum-only extras
      vaccinTuse: isPlatinum ? {
        folosit: !!f['Vaccin tuse canisa folosit'],
        data: f['Data vaccin tuse'] || null,
      } : null,
      consultatieA2a: isPlatinum ? {
        folosita: !!f['A 2-a consultatie folosita'],
        data: f['Data a 2-a consultatie'] || null,
      } : null,
      consultatieSpecialitate: isPlatinum ? {
        folosita: !!f['Consultatie de specialitate folosita'],
        data: f['Data consultatie specialitate'] || null,
      } : null,
      note: f['Note'] || '',
    });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
