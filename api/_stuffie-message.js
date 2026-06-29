import {
  createTurnstileSession,
  enforceBodySize,
  enforceOrigin,
  getClientIp,
  isHoneypotFilled,
  rateLimit,
  setNoStore,
  verifyTurnstile,
  verifyTurnstileSession,
} from './_security.js';
import {
  applySecurityToPayload,
  assessLeadRisk,
  leadSecurityContext,
  persistentRateLimit,
  recordLeadSignal,
  shouldSkipInsertForDuplicate,
} from './_lead-security.js';

const DEFAULT_N8N_URL = 'https://stuffie.vet-stuff.ro/webhook/stuffie-brain';
const DEFAULT_CLINIC_ID = '00000000-0000-0000-0000-000000000001';
const REQUIRED_LEAD_FIELDS = [
  'nume complet',
  'telefon valid',
  'email',
  'specie',
  'numele animalului',
  'varsta animalului',
  'motivul solicitarii',
];

export async function handleStuffieMessage(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!enforceOrigin(req, res)) return;
  if (!rateLimit(req, res, 'stuffie-message', { max: 30, windowMs: 15 * 60 * 1000 })) return;
  if (isHoneypotFilled(req.body || {})) return res.status(200).json({ ok: true, raspuns: '' });
  if (!enforceBodySize(req, res, 32 * 1024)) return;

  const body = sanitizeMessage(req.body || {});
  if (!body.ok) return res.status(400).json({ error: body.error });

  const context = leadSecurityContext(req, req.body || {});
  const [ipLimit, deviceLimit] = await Promise.all([
    persistentRateLimit({ supabaseFetch, name: 'stuffie-ip', key: context.ipPrefix, max: 30, windowMs: 15 * 60 * 1000 }),
    persistentRateLimit({ supabaseFetch, name: 'stuffie-device', key: context.deviceId || context.sessionId, max: 20, windowMs: 15 * 60 * 1000 }),
  ]);
  if (!ipLimit.ok || !deviceLimit.ok) {
    return res.status(429).json({ error: 'Prea multe mesaje într-un interval scurt.' });
  }

  const captcha = await verifyStuffieCaptcha(req, body.value);
  if (!captcha.ok) return res.status(400).json({ error: captcha.error || 'Captcha failed' });

  try {
    const clinicId = resolveClinicId();
    await recordStuffieChatMessage({
      clinicId,
      canal: body.value.canal,
      userId: body.value.userId,
      role: 'user',
      content: body.value.mesaj,
      metadata: { gateway: 'website', deviceId: context.deviceId || null },
    });
    const recentHistory = await loadStuffieChatHistory({
      clinicId,
      canal: body.value.canal,
      userId: body.value.userId,
    });
    const historyText = formatStuffieHistory(recentHistory);
    const n8n = await callStuffieBrain({
      clinic_id: clinicId,
      canal: body.value.canal,
      user_id: body.value.userId,
      mesaj: body.value.mesaj,
      conversation_history: historyText,
      create_crm_lead: false,
      security_gateway: 'website',
    });
    let cleanReply = cleanEscalationMarker(n8n.raspuns || '');
    const escalationType = normalizeEscalationType(n8n.escalation_type || detectEscalationMarker(n8n.raspuns));
    const leadResult = await maybeCreateStuffieLead({ body: body.value, reply: cleanReply, escalationType, context, historyText });
    const storedEscalationType = leadResult.escalation_type || escalationType;
    if (leadResult.needs_more_info) {
      cleanReply = buildMissingLeadInfoReply(leadResult);
    }
    await recordStuffieChatMessage({
      clinicId,
      canal: body.value.canal,
      userId: body.value.userId,
      role: 'assistant',
      content: cleanReply,
      escalationType: storedEscalationType,
      appointmentRequestId: leadResult.requestId || null,
      metadata: {
        gateway: 'website',
        lead: leadResult,
      },
    });

    return res.status(200).json({
      ok: true,
      raspuns: cleanReply,
      canal: body.value.canal,
      user_id: body.value.userId,
      lead: leadResult,
      turnstileSession: captcha.session?.token || req.body?.turnstileSession || null,
      turnstileSessionExpiresAt: captcha.session?.expiresAt || captcha.expiresAt || null,
    });
  } catch (err) {
    console.error('[stuffie-message]', err?.message || err);
    return res.status(502).json({
      ok: false,
      raspuns: 'Momentan nu reușesc să mă conectez. Te rog scrie-ne pe vet-stuff.ro/contact sau încearcă din nou. 🐾',
    });
  }
}

async function verifyStuffieCaptcha(req, body) {
  const ip = getClientIp(req);
  const subject = req.body?.deviceId || body.userId;
  const session = verifyTurnstileSession(req.body?.turnstileSession, {
    scope: 'stuffie-message',
    subject,
    ip,
  });
  if (session.ok) return session;

  const captcha = await verifyTurnstile(req.body?.turnstileToken, ip);
  if (!captcha.ok) return captcha;

  return {
    ok: true,
    session: createTurnstileSession({
      scope: 'stuffie-message',
      subject,
      ip,
    }),
  };
}

async function maybeCreateStuffieLead({ body, reply, escalationType, context, historyText = '' }) {
  const leadRaw = clientOnlyLeadText(historyText, body.mesaj);
  const inferenceRaw = [leadRaw, reply].filter(Boolean).join('\n');
  const leadDetails = extractLeadDetails(leadRaw);
  const effectiveEscalationType = ['OM', 'URGENTA'].includes(escalationType)
    ? escalationType
    : inferEscalationType({ raw: inferenceRaw, details: leadDetails });
  if (!['OM', 'URGENTA'].includes(effectiveEscalationType)) return { created: false, reason: 'no_escalation' };

  const intent = effectiveEscalationType === 'URGENTA' ? 'urgent' : 'callback';
  if (!leadDetails.ok) {
    const payload = fallbackPayload({ body, reply, details: leadDetails, escalationType: effectiveEscalationType });
    const risk = await assessLeadRisk({
      supabaseFetch,
      payload,
      context,
      intent,
      source: `chatbot_${body.canal}`,
    });
    await recordLeadSignal({ supabaseFetch, payload, context, risk, source: `chatbot_${body.canal}`, intent });
    return {
      created: false,
      needs_more_info: true,
      reason: 'missing_required_fields',
      escalation_type: effectiveEscalationType,
      missing: leadDetails.missing,
      invalid: leadDetails.invalid,
      required: REQUIRED_LEAD_FIELDS,
    };
  }

  let payload = fallbackPayload({ body, reply, details: leadDetails, escalationType: effectiveEscalationType });
  const risk = await assessLeadRisk({
    supabaseFetch,
    payload,
    context,
    intent,
    source: `chatbot_${body.canal}`,
  });

  if (risk.action === 'soft_block') {
    await recordLeadSignal({ supabaseFetch, payload, context, risk, source: `chatbot_${body.canal}`, intent });
    return { created: false, reason: 'soft_block', risk_score: risk.score, escalation_type: effectiveEscalationType };
  }

  if (shouldSkipInsertForDuplicate(risk, intent)) {
    await recordLeadSignal({
      supabaseFetch,
      payload,
      context,
      risk,
      source: `chatbot_${body.canal}`,
      intent,
      duplicateOfRequestId: risk.duplicate?.id || null,
    });
    return {
      created: false,
      duplicate: true,
      requestId: risk.duplicate?.id || null,
      risk_score: risk.score,
      risk_reasons: risk.reasons,
      escalation_type: effectiveEscalationType,
    };
  }

  payload = applySecurityToPayload(payload, risk, context);
  const created = await supabaseFetch('appointment_requests', {
    method: 'POST',
    body: payload,
    headers: { Prefer: 'return=representation' },
  });
  const request = Array.isArray(created) ? created[0] : created;
  await recordLeadSignal({
    supabaseFetch,
    payload,
    context,
    risk,
    source: `chatbot_${body.canal}`,
    intent,
    appointmentRequestId: request?.id || null,
    duplicateOfRequestId: risk.duplicate?.id || null,
  });
  return { created: true, requestId: request?.id || null, risk_score: risk.score, risk_reasons: risk.reasons, escalation_type: effectiveEscalationType };
}

function fallbackPayload({ body, reply, details = {}, escalationType = 'OM' }) {
  const clientRaw = String(body.mesaj || '');
  const raw = [clientRaw, reply].filter(Boolean).join('\n');
  const urgent = escalationType === 'URGENTA';
  const species = details.species || detectSpecies(clientRaw) || detectSpecies(raw);
  const ownerName = details.ownerName || detectOwnerName(clientRaw) || 'Client STUFFIE';
  const patientName = details.petName || detectPetName(clientRaw) || (species ? species.toUpperCase() : 'Pacient STUFFIE');
  const cleanReply = cleanEscalationMarker(reply || '');
  const ageLine = details.petAge ? `\nVarsta animal: ${details.petAge}` : '';
  const reasonLine = details.reason ? `\nMotiv validat: ${details.reason}` : '';

  return {
    clinic_id: resolveClinicId(),
    owner_name: ownerName,
    owner_phone: details.phone || '',
    owner_email: details.email || null,
    patient_name: patientName,
    patient_species: species || null,
    visit_type_key: urgent ? 'urgenta' : 'callback_stuffie',
    visit_type_label: urgent ? 'Urgență STUFFIE' : 'Callback STUFFIE',
    doctor_id: null,
    doctor_name: urgent ? 'Dr. Marinescu' : null,
    duration_minutes: 30,
    message: (urgent ? 'Lead URGENT creat prin gateway STUFFIE.' : 'Lead callback creat prin gateway STUFFIE.') +
      '\n\nMesaj client:\n' + (body.mesaj || '-') +
      ageLine +
      reasonLine +
      '\n\nRaspuns STUFFIE:\n' + cleanReply,
    source: `chatbot_${body.canal || 'website'}`,
    status: 'new',
    chatbot_user_id: body.userId || null,
    preferred_date_text: urgent ? 'Urgență STUFFIE - contact telefonic imediat' : 'Callback cerut prin STUFFIE',
    website_payload_raw: {
      canal: body.canal || null,
      user_id: body.userId || null,
      mesaj_client: body.mesaj || null,
      raspuns_stuffie: cleanReply,
      escalation_type: escalationType,
      phone_detected: details.phone || null,
      email_detected: details.email || null,
      required_fields_validated: Boolean(details.ok),
      pet_age: details.petAge || null,
      lead_reason: details.reason || null,
      gateway: 'website',
    },
  };
}

async function recordStuffieChatMessage({ clinicId, canal, userId, role, content, escalationType = null, appointmentRequestId = null, metadata = {} }) {
  if (!content || !userId) return null;
  try {
    const rows = await supabaseFetch('chat_conversations', {
      method: 'POST',
      body: {
        clinic_id: clinicId,
        canal,
        user_id: userId,
        role,
        content: String(content).slice(0, 8000),
        escalation_type: escalationType || null,
        appointment_request_id: appointmentRequestId || null,
        metadata,
      },
      headers: { Prefer: 'return=representation' },
    });
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (err) {
    console.error('[stuffie-chat:record]', err?.message || err);
    return null;
  }
}

async function loadStuffieChatHistory({ clinicId, canal, userId, limit = 12 }) {
  if (!userId) return [];
  try {
    const path = [
      'chat_conversations',
      '?select=role,content,created_at',
      `&clinic_id=eq.${encodeURIComponent(clinicId)}`,
      `&canal=eq.${encodeURIComponent(canal)}`,
      `&user_id=eq.${encodeURIComponent(userId)}`,
      '&order=created_at.desc',
      `&limit=${Math.min(Math.max(Number(limit) || 12, 1), 20)}`,
    ].join('');
    const rows = await supabaseFetch(path);
    return Array.isArray(rows) ? rows.reverse() : [];
  } catch (err) {
    console.error('[stuffie-chat:history]', err?.message || err);
    return [];
  }
}

function formatStuffieHistory(rows = []) {
  return rows
    .filter(row => row?.content)
    .map(row => `${row.role === 'assistant' ? 'STUFFIE' : 'Client'}: ${String(row.content).replace(/\s+/g, ' ').trim()}`)
    .join('\n')
    .slice(-5000);
}

function clientOnlyLeadText(historyText = '', currentMessage = '') {
  const clientHistory = String(historyText || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => /^Client\s*:/i.test(line))
    .map(line => line.replace(/^Client\s*:\s*/i, '').trim())
    .filter(Boolean)
    .join('\n');
  return [clientHistory, currentMessage].filter(Boolean).join('\n');
}

function resolveClinicId() {
  return process.env.CLINIC_ID || DEFAULT_CLINIC_ID;
}

async function callStuffieBrain(payload) {
  const internalToken = process.env.INTERNAL_API_TOKEN;
  if (!internalToken) throw new Error('INTERNAL_API_TOKEN is required for STUFFIE gateway');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90 * 1000);
  try {
    const response = await fetch(process.env.STUFFIE_BRAIN_URL || DEFAULT_N8N_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': internalToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || data?.error || `STUFFIE ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeMessage(body) {
  const mesaj = String(body.mesaj || body.message || '').trim();
  const canal = cleanKey(body.canal || 'website', 40) || 'website';
  const userId = cleanKey(body.user_id || body.userId || body.sessionId || '', 120);
  if (!mesaj) return { ok: false, error: 'Mesajul este obligatoriu.' };
  if (mesaj.length > 3000) return { ok: false, error: 'Mesajul este prea lung.' };
  if (!userId) return { ok: false, error: 'Sesiunea este invalidă.' };
  return { ok: true, value: { mesaj, canal, userId } };
}

function cleanEscalationMarker(text = '') {
  return String(text || '').replace(/\[ESCALADARE:[A-Z]+\]/g, '').trim();
}

function detectEscalationMarker(text = '') {
  return String(text || '').match(/\[ESCALADARE:([A-Z]+)\]/)?.[1] || '';
}

function normalizeEscalationType(value = '') {
  const clean = String(value || '').trim().toUpperCase();
  return ['OM', 'URGENTA'].includes(clean) ? clean : '';
}

function inferEscalationType({ raw = '', details = {} } = {}) {
  const text = String(raw || '').toLowerCase();
  if (!details.ok) return '';
  if (/\b(urgenta|urgență|urgent|nu se ridica|nu se ridică|sangereaza|sângerează|respira greu|respiră greu|convulsii|otravit|otrăvit)\b/i.test(text)) {
    return 'URGENTA';
  }
  if (/\b(programare|programa|consult|consulta|consultație|consultatie|contact|suna|sună|sunati|sunați|clinica|solicitare|vreau|doresc|am nevoie)\b/i.test(text)) {
    return 'OM';
  }
  return '';
}

function detectOwnerName(raw = '') {
  const match = String(raw || '').match(/(?:numele meu este|numele este|nume complet[:\s]+|nume(?:le)?[:\s]+|ma numesc|mă numesc|sunt|ma cheama|mă cheamă)\s*([A-ZĂÂÎȘȚ][\p{L}' -]{1,60})/iu);
  return match?.[1]?.replace(/\s+(si|și|telefon|tel).*$/i, '').trim() || detectLeadingFullName(raw);
}

function detectSpecies(raw = '') {
  const match = String(raw || '').match(/\b(caine|câine|catel|cățel|pisica|pisică|motan|pisoi|iepure|hamster|papagal)\b/iu);
  const species = match?.[1]?.toLowerCase() || '';
  if (/caine|câine|catel|cățel/i.test(species)) return 'câine';
  if (/pisica|pisică|motan|pisoi/i.test(species)) return 'pisică';
  return species || '';
}

function detectPetName(raw = '') {
  const match = String(raw || '').match(/(?:animalul|câinele|cainele|cățelul|catelul|pisica|motanul|pacientul|numele animalului|nume animal|animal)(?: meu| mea)?\s*(?:se numește|se numeste|îl cheamă|il cheama|o cheamă|o cheama|:)?\s+([\p{L}' -]{2,35})/iu)
    || String(raw || '').match(/\b(?:caine|câine|catel|cățel|pisica|pisică|motan|pisoi)\b\s*[,;:-]\s*([\p{L}' -]{2,35})/iu);
  return match?.[1]?.replace(/\s+(si|și|are|cu).*$/i, '').trim() || '';
}

export function extractLeadDetails(raw = '') {
  const text = String(raw || '');
  const details = {
    ownerName: validFullName(detectOwnerName(text)),
    phone: detectValidPhone(text),
    email: detectEmail(text),
    species: detectSpecies(text),
    petName: detectPetName(text),
    petAge: detectPetAge(text),
    reason: detectReason(text),
  };
  const missing = [];
  const invalid = [];

  if (!details.ownerName) missing.push('nume complet (prenume si nume)');
  const phoneCandidate = detectAnyPhoneCandidate(text);
  if (!details.phone) {
    (phoneCandidate ? invalid : missing).push('telefon valid in format international sau romanesc');
  }
  if (!details.email) missing.push('adresa de email valida');
  if (!details.species) missing.push('specia animalului (caine sau pisica)');
  if (!details.petName) missing.push('numele animalului');
  if (!details.petAge) missing.push('varsta animalului');
  if (!details.reason) missing.push('motivul solicitarii');

  return { ...details, missing, invalid, ok: missing.length === 0 && invalid.length === 0 };
}

function validFullName(value = '') {
  const clean = String(value || '').replace(/[^\p{L}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  const parts = clean.split(' ').filter(part => part.replace(/[-']/g, '').length >= 2);
  return parts.length >= 2 ? parts.slice(0, 4).join(' ') : '';
}

function detectLeadingFullName(raw = '') {
  const lines = String(raw || '').split(/\n+/);
  for (const line of lines) {
    const clean = line
      .replace(/^\s*(Client|Utilizator|User)\s*:\s*/i, '')
      .replace(/[+0-9][\d\s().-]{7,20}.*$/u, '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}.*$/iu, '')
      .split(/[,;|]/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (/^(medicul|buna|bună|te rog|telefon|email|specie|motiv|varsta|vârsta)\b/iu.test(clean)) continue;
    const match = clean.match(/^([A-ZĂÂÎȘȚ][\p{L}'-]{1,30}\s+[A-ZĂÂÎȘȚ][\p{L}'-]{1,30}(?:\s+[A-ZĂÂÎȘȚ][\p{L}'-]{1,30})?)/u);
    if (match) return match[1].trim();
  }
  return '';
}

function detectValidPhone(raw = '') {
  const text = String(raw || '');
  const candidates = text.match(/(?:\+\d[\d\s().-]{7,20}|00\d[\d\s().-]{7,20}|\b0\d[\d\s().-]{8,13}\b)/g) || [];
  for (const candidate of candidates) {
    const normalized = normalizePhone(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function detectAnyPhoneCandidate(raw = '') {
  return String(raw || '').match(/\+?\d[\d\s().-]{5,20}/)?.[0] || '';
}

function normalizePhone(value = '') {
  let clean = String(value || '').trim().replace(/[^\d+]/g, '');
  if (clean.startsWith('00')) clean = `+${clean.slice(2)}`;
  if (clean.startsWith('0') && clean.length === 10) clean = `+40${clean.slice(1)}`;
  if (clean.startsWith('+400') && clean.length === 13) clean = `+40${clean.slice(4)}`;
  if (/^\+40[2-8]\d{8}$/.test(clean)) return clean;
  if (/^\+[1-9]\d{7,14}$/.test(clean)) return clean;
  return '';
}

function detectEmail(raw = '') {
  return String(raw || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase() || '';
}

function detectPetAge(raw = '') {
  const match = String(raw || '').match(/\b(?:varsta|vârsta|are)\s*(?:este|:)?\s*(\d{1,2})\s*(ani|an|luni|luna|lună|saptamani|săptămâni|saptamana|săptămână|zile|zi)\b/iu)
    || String(raw || '').match(/\b(\d{1,2})\s*(ani|an|luni|luna|lună|saptamani|săptămâni|saptamana|săptămână|zile|zi)\b/iu);
  if (!match) return '';
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0 || number > 40) return '';
  return `${number} ${match[2].toLowerCase()}`;
}

function detectReason(raw = '') {
  const match = String(raw || '').match(/(?:motiv|problema|problemă|pentru|deoarece|vreau|as dori|aș dori|am nevoie)\s*(?:este|:)?\s+([^\n.]{8,180})/iu);
  const reason = match?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const common = String(raw || '').match(/\b(consult|consultație|consultatie|vaccinare|vaccin|deparazitare|control|urgență|urgenta|sterilizare|analize)\b/iu)?.[1] || '';
  if (!reason) return common ? common.toLowerCase() : '';
  if (/\b(contact|contactat|contactata|contactată|contacteze|suna|sunati|sunați|programare)\b/iu.test(reason)) {
    return common ? common.toLowerCase() : '';
  }
  return reason;
}

function buildMissingLeadInfoReply(result) {
  const items = [...new Set([...(result.missing || []), ...(result.invalid || [])])];
  const list = items.map(item => `- ${item}`).join('\n');
  return [
    '🐾 MEDICUL TĂU DE FAMILIE EXTINSĂ',
    '',
    'Pot transmite solicitarea către clinică doar după ce am datele complete și valide, ca echipa să te poată contacta corect.',
    '',
    'Te rog trimite într-un singur mesaj:',
    list,
    '',
    'Telefonul trebuie să fie valid, de exemplu +407xxxxxxxx sau 07xxxxxxxx. Nu am transmis încă solicitarea către clinică.',
  ].join('\n');
}

function cleanKey(value, max = 80) {
  return String(value || '').trim().replace(/[^a-z0-9._:-]/gi, '').slice(0, max);
}

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  return { url, key, configured: Boolean(url && key) };
}

async function supabaseFetch(path, options = {}) {
  const config = supabaseConfig();
  if (!config.configured) throw new Error('Supabase is not configured');
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
