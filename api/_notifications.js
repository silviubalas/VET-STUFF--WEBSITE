import { getSmsLinkConfig, sendSmsLink } from './_smslink.js';

export async function sendSubscriptionConfirmationEmail({ email, nume, plan, animal, cod }) {
  const token = process.env.RESEND_API_KEY;
  if (!token) {
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY missing' };
  }

  const safeEmail = String(email || '').trim().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return { ok: false, status: 400, error: 'Email invalid' };
  }
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(String(cod || ''))) {
    return { ok: false, status: 400, error: 'Cod invalid' };
  }

  const safeNume = String(nume || '').slice(0, 100);
  const safePlan = String(plan || '').slice(0, 80);
  const safeAnimal = String(animal || '').slice(0, 80);
  const safeCod = String(cod).slice(0, 32);
  const statusUrl = 'https://www.vet-stuff.ro/status.html?cod=' + encodeURIComponent(safeCod);
  const useUrl = 'https://www.vet-stuff.ro/u.html?cod=' + encodeURIComponent(safeCod);
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=' + encodeURIComponent(useUrl);

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:600px; margin:0 auto; padding:24px; color:#1f2937; line-height:1.6;">
  <div style="text-align:center; padding:24px 0; border-bottom:2px solid #b52020;">
    <h1 style="color:#b52020; margin:0; font-size:24px;">VET STUFF</h1>
    <p style="color:#6b7280; margin:6px 0 0; font-size:14px;">Clinică Veterinară Bacău</p>
  </div>
  <h2 style="color:#1f2937; margin-top:32px;">Salut${safeNume ? ', ' + escapeHtml(safeNume) : ''}!</h2>
  <p>Mulțumim că ai ales un abonament VET STUFF pentru <strong>${escapeHtml(safeAnimal) || 'animalul tău'}</strong>.</p>
  <p>Pachetul tău <strong>${escapeHtml(safePlan)}</strong> a fost înregistrat cu succes.</p>
  <div style="background:#fef2f2; border:2px dashed #b52020; border-radius:12px; padding:20px; margin:24px 0; text-align:center;">
    <p style="margin:0 0 8px; color:#6b7280; font-size:13px; text-transform:uppercase; letter-spacing:1px;">Codul tău unic</p>
    <p style="margin:0; font-size:28px; font-weight:bold; color:#b52020; letter-spacing:2px; font-family:'Menlo','Courier New',monospace;">${escapeHtml(safeCod)}</p>
  </div>
  <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin:24px 0; text-align:center;">
    <p style="margin:0 0 12px; color:#6b7280; font-size:13px; text-transform:uppercase; letter-spacing:1px;">Codul QR pentru clinică</p>
    <img src="${qrUrl}" alt="Cod QR abonament" width="240" height="240" style="display:block; margin:0 auto; background:#fff; padding:10px; border-radius:8px; border:1px solid #e5e7eb;">
    <p style="margin:12px 0 0; color:#6b7280; font-size:13px; line-height:1.5;">La fiecare vizită, arată acest QR medicului.<br>El va înregistra serviciile folosite pe loc.</p>
  </div>
  <p>Cu acest cod poți verifica oricând statusul abonamentului — ce servicii ai folosit și ce mai ai disponibil:</p>
  <div style="text-align:center; margin:32px 0;">
    <a href="${statusUrl}" style="display:inline-block; background:#b52020; color:#fff; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:16px;">Verifică status abonament</a>
  </div>
  <p style="font-size:14px; color:#6b7280;">Sau accesează direct: <a href="${statusUrl}" style="color:#b52020;">${statusUrl}</a></p>
  <hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0;">
  <h3 style="color:#1f2937;">Ce urmează?</h3>
  <ol style="color:#4b5563;">
    <li>Te vom contacta în scurt timp pentru a stabili produsele exacte și data primei consultații.</li>
    <li>Plata se face integral sau în 3 rate egale, pe parcursul a 60 de zile.</li>
    <li>După prima vizită, abonamentul devine activ pentru 12 luni.</li>
  </ol>
  <hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0;">
  <p style="font-size:13px; color:#9ca3af; text-align:center;">
    Acest email a fost trimis de VET STUFF — Clinică Veterinară Bacău<br>
    Pentru întrebări, răspunde la acest email sau scrie-ne pe Messenger.
  </p>
</body>
</html>`;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'VET STUFF <noreply@vet-stuff.ro>',
        to: [safeEmail],
        subject: 'Abonamentul tău VET STUFF — Codul: ' + safeCod,
        html,
      }),
    });

    if (!resendRes.ok) {
      const text = await resendRes.text();
      return { ok: false, status: resendRes.status, error: text.slice(0, 500) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, status: 502, error: String(err?.message || err) };
  }
}

export async function sendSubscriptionSms({ tel, cod, animal, plan }) {
  if (!getSmsLinkConfig().configured) {
    return { ok: false, skipped: true, reason: 'SMS not configured' };
  }

  if (!tel || !cod) return { ok: false, status: 400, error: 'tel si cod sunt obligatorii' };
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(String(cod))) {
    return { ok: false, status: 400, error: 'Format cod invalid' };
  }

  const statusUrl = 'https://vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);
  const body = [
    'VET STUFF: Abonamentul a fost inregistrat.',
    plan ? 'Plan: ' + String(plan).slice(0, 30) : '',
    animal ? 'Pentru: ' + String(animal).slice(0, 50) : '',
    'Cod: ' + cod,
    'Status: ' + statusUrl,
  ].filter(Boolean).join('\n');

  return sendSmsLink({ to: tel, body });
}

export async function notifySubscriptionLead(fields) {
  return notifyFormspree(fields?._subject || 'VET STUFF — formular abonament', fields);
}

// Notifică clinica (vet.stuff@yahoo.com) direct prin Resend când vine o cerere
// de programare de pe website. Canal sigur, verificat (independent de Formspree).
export async function sendClinicBookingEmail(fields) {
  const token = process.env.RESEND_API_KEY;
  if (!token) return { ok: false, skipped: true, reason: 'RESEND_API_KEY missing' };

  const to = String(process.env.CLINIC_NOTIFY_EMAIL || 'vet.stuff@yahoo.com').trim();
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.owner_email || ''))
    ? String(fields.owner_email)
    : undefined;

  let intervalLabel = String(fields.preferred_at || '');
  try {
    intervalLabel = new Intl.DateTimeFormat('ro-RO', {
      timeZone: 'Europe/Bucharest',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(fields.preferred_at));
  } catch { /* păstrează raw */ }

  const rows = [
    ['Client', fields.owner_name],
    ['Telefon', fields.owner_phone],
    ['Email', fields.owner_email || '—'],
    ['Animal', `${fields.patient_name || '—'}${fields.patient_species ? ` (${fields.patient_species})` : ''}`],
    ['Serviciu', fields.visit_type_label || fields.visit_type_key || '—'],
    ['Medic', fields.doctor_name || '—'],
    ['Interval dorit', intervalLabel],
    ['Mesaj', fields.message || '—'],
  ];
  const rowsHtml = rows.map(([k, v]) => `
    <tr>
      <td style="padding:8px 12px; color:#6b7280; font-size:13px; white-space:nowrap; vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:8px 12px; color:#1f2937; font-size:14px; font-weight:600;">${escapeHtml(v)}</td>
    </tr>`).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:600px; margin:0 auto; padding:24px; color:#1f2937; line-height:1.5;">
  <div style="text-align:center; padding:20px 0; border-bottom:2px solid #E31B23;">
    <h1 style="color:#E31B23; margin:0; font-size:22px;">VET STUFF</h1>
    <p style="color:#6b7280; margin:6px 0 0; font-size:13px;">Cerere nouă de programare — de pe website</p>
  </div>
  <p style="margin:24px 0 8px;">A intrat o <strong>cerere de programare online</strong>. Confirm-o (sau respinge-o) din CRM, secțiunea <strong>Programări noi</strong>.</p>
  <table style="width:100%; border-collapse:collapse; background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; margin:16px 0;">
    ${rowsHtml}
  </table>
  ${fields.request_id ? `<p style="font-size:12px; color:#9ca3af;">ID cerere: ${escapeHtml(fields.request_id)}</p>` : ''}
  <div style="text-align:center; margin:28px 0;">
    <a href="https://crm.vet-stuff.ro/programari" style="display:inline-block; background:#1B2A4A; color:#fff; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:15px;">Deschide în CRM</a>
  </div>
  <hr style="border:none; border-top:1px solid #e5e7eb; margin:28px 0;">
  <p style="font-size:12px; color:#9ca3af; text-align:center;">Programarea NU este încă confirmată. Devine fermă doar după acceptarea din CRM.</p>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'VET STUFF <noreply@vet-stuff.ro>',
        to: [to],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: `Cerere nouă de programare — ${fields.patient_name || 'animal'} (${fields.owner_name || 'client'})`,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, status: 502, error: String(err?.message || err) };
  }
}

export async function notifyFormspree(subject, fields) {
  const endpoint = process.env.FORMSPREE_ENDPOINT || 'https://formspree.io/f/mzdkbdzb';
  if (!endpoint) return { ok: false, skipped: true };

  const fd = new FormData();
  if (subject) fd.append('_subject', subject);
  Object.entries(fields || {}).forEach(([key, value]) => fd.append(key, value ?? ''));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: fd,
      headers: { 'Accept': 'application/json' },
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, status: 502, error: String(err?.message || err) };
  }
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
