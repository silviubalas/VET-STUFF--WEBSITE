import crypto from 'node:crypto';
import { getClientIp } from './_security.js';

const ACTIVE_STATUSES = 'new,in_review,accepted';
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizePhone(value = '') {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('0040')) return `0${digits.slice(4)}`;
  if (digits.startsWith('40')) return `0${digits.slice(2)}`;
  if (digits.startsWith('7') && digits.length === 9) return `0${digits}`;
  return digits;
}

export function extractRomanianPhone(text = '') {
  const match = String(text || '').match(/(?:\+?4?0[\s.-]?)?0?7[\d\s.-]{7,12}/);
  return normalizePhone(match?.[0] || '');
}

export function publicDeviceId(value = '') {
  const clean = String(value || '').trim();
  return /^[a-z0-9._:-]{8,120}$/i.test(clean) ? clean : '';
}

export function leadSecurityContext(req, body = {}) {
  const ip = getClientIp(req);
  const userAgent = String(req.headers?.['user-agent'] || '').slice(0, 500);
  const deviceId = publicDeviceId(body.deviceId || body.device_id || body.deviceIdHash || '');
  const sessionId = publicDeviceId(body.user_id || body.sessionId || body.chatbot_user_id || '');
  const ipPrefix = normalizeIpPrefix(ip);

  return {
    ip,
    ipPrefix,
    userAgent,
    deviceId,
    sessionId,
    deviceIdHash: hashValue(deviceId),
    sessionIdHash: hashValue(sessionId),
    ipPrefixHash: hashValue(ipPrefix),
    userAgentHash: hashValue(userAgent),
  };
}

export async function persistentRateLimit({ supabaseFetch, name, key, max, windowMs }) {
  if (!key || !supabaseFetch) return { ok: true, skipped: true };
  const now = Date.now();
  const resetAt = new Date(now + windowMs);
  const hashKey = `${name}:${hashValue(key)}`;

  try {
    const rows = await supabaseFetch(`lead_rate_limits?select=key,count,reset_at&key=eq.${encodeURIComponent(hashKey)}&limit=1`);
    const current = Array.isArray(rows) ? rows[0] : null;
    if (!current) {
      await supabaseFetch('lead_rate_limits', {
        method: 'POST',
        body: { key: hashKey, name, count: 1, reset_at: resetAt.toISOString(), updated_at: new Date(now).toISOString() },
        headers: { Prefer: 'return=minimal' },
      });
      return { ok: true, remaining: max - 1, resetAt };
    }

    if (new Date(current.reset_at).getTime() <= now) {
      await supabaseFetch(`lead_rate_limits?key=eq.${encodeURIComponent(hashKey)}`, {
        method: 'PATCH',
        body: { name, count: 1, reset_at: resetAt.toISOString(), updated_at: new Date(now).toISOString() },
        headers: { Prefer: 'return=minimal' },
      });
      return { ok: true, remaining: max - 1, resetAt };
    }

    const count = Number(current.count || 0) + 1;
    await supabaseFetch(`lead_rate_limits?key=eq.${encodeURIComponent(hashKey)}`, {
      method: 'PATCH',
      body: { count, updated_at: new Date(now).toISOString() },
      headers: { Prefer: 'return=minimal' },
    });
    return { ok: count <= max, remaining: Math.max(0, max - count), resetAt: new Date(current.reset_at) };
  } catch (err) {
    console.error('[lead-security:rate-limit]', err?.message || err);
    return { ok: true, skipped: true, error: 'rate-limit-unavailable' };
  }
}

export async function assessLeadRisk({ supabaseFetch, payload, context, intent = 'normal_booking', source = 'website' }) {
  const phone = normalizePhone(payload.owner_phone);
  const email = normalizeEmail(payload.owner_email);
  const phoneHash = hashValue(phone);
  const emailHash = hashValue(email);
  const text = normalizeText([payload.owner_name, payload.patient_name, payload.message].filter(Boolean).join(' '));
  const dedupeKey = hashValue([
    source,
    intent,
    phone,
    normalizeText(payload.patient_name),
    payload.visit_type_key || '',
    String(payload.preferred_at || '').slice(0, 10),
  ].join('|'));

  const risk = {
    score: 0,
    reasons: [],
    action: 'allow',
    duplicate: null,
    activeBlocks: [],
    dedupeKey,
    phoneHash,
    emailHash,
    phoneLast4: phone ? phone.slice(-4) : null,
  };

  if (!phone || phone.length < 10) addRisk(risk, 10, 'telefon_invalid');
  if (!context.userAgent) addRisk(risk, 15, 'user_agent_lipsa');
  if (text && isLowInformationText(text)) addRisk(risk, 25, 'mesaj_repetitiv_sau_scurt');

  const activeBlocks = await loadActiveBlocks(supabaseFetch, {
    phoneHash,
    deviceIdHash: context.deviceIdHash,
    ipPrefixHash: context.ipPrefixHash,
  });
  if (activeBlocks.length) {
    risk.activeBlocks = activeBlocks;
    if (activeBlocks.some(block => block.subject_type === 'phone')) addRisk(risk, 100, 'telefon_blocat_activ');
    if (activeBlocks.some(block => block.subject_type === 'device')) addRisk(risk, 90, 'device_blocat_activ');
    if (activeBlocks.some(block => block.subject_type === 'ip')) addRisk(risk, 80, 'ip_blocat_activ');
  }

  const since = new Date(Date.now() - DAY_MS).toISOString();
  const existing = await loadExistingRequests(supabaseFetch, { phone, phoneHash, deviceIdHash: context.deviceIdHash, ipPrefixHash: context.ipPrefixHash, since });

  const activeByPhone = existing.filter(item => samePhone(item, phone, phoneHash));
  if (activeByPhone.length) {
    addRisk(risk, 40, 'telefon_cu_lead_activ_24h');
    risk.duplicate = pickDuplicate(activeByPhone, payload, intent);
  }

  const activeByDevice = existing.filter(item => item.device_id_hash && item.device_id_hash === context.deviceIdHash);
  if (activeByDevice.length >= 3) addRisk(risk, 30, 'device_cu_3_leaduri_24h');

  const activeByIp = existing.filter(item => item.ip_prefix_hash && item.ip_prefix_hash === context.ipPrefixHash);
  if (activeByIp.length >= 8) addRisk(risk, 25, 'ip_cu_8_leaduri_24h');

  const differentNameSamePhone = activeByPhone.some(item => (
    normalizeText(item.owner_name) &&
    normalizeText(payload.owner_name) &&
    normalizeText(item.owner_name) !== normalizeText(payload.owner_name)
  ));
  if (differentNameSamePhone) addRisk(risk, 20, 'nume_diferit_acelasi_telefon');

  if (risk.activeBlocks.length && intent !== 'urgent') risk.action = 'soft_block';
  else if (risk.score >= 90) risk.action = intent === 'urgent' ? 'allow_flagged' : 'soft_block';
  else if (risk.score >= 70 && risk.duplicate) risk.action = 'merge_duplicate';
  else if (risk.score >= 50) risk.action = intent === 'urgent' ? 'allow_flagged' : 'challenge';
  else if (risk.score >= 30) risk.action = 'allow_flagged';

  return risk;
}

export function securityFields({ risk, context }) {
  return {
    risk_score: risk.score,
    risk_reasons: risk.reasons,
    dedupe_key: risk.dedupeKey || null,
    device_id_hash: context.deviceIdHash || null,
    ip_prefix_hash: context.ipPrefixHash || null,
    user_agent_hash: context.userAgentHash || null,
    phone_hash: risk.phoneHash || null,
    email_hash: risk.emailHash || null,
    lead_security_action: risk.action,
    lead_security_checked_at: new Date().toISOString(),
    request_ip: context.ipPrefix || null,
    user_agent: context.userAgent || null,
  };
}

export async function recordLeadSignal({ supabaseFetch, payload, context, risk, source, intent, appointmentRequestId = null, duplicateOfRequestId = null }) {
  if (!supabaseFetch) return;
  try {
    await supabaseFetch('lead_abuse_signals', {
      method: 'POST',
      body: {
        clinic_id: payload.clinic_id || null,
        source,
        intent,
        phone_hash: risk.phoneHash || null,
        email_hash: risk.emailHash || null,
        device_id_hash: context.deviceIdHash || null,
        ip_prefix_hash: context.ipPrefixHash || null,
        user_agent_hash: context.userAgentHash || null,
        session_id_hash: context.sessionIdHash || null,
        normalized_phone_last4: risk.phoneLast4 || null,
        risk_score: risk.score,
        risk_reasons: risk.reasons,
        appointment_request_id: appointmentRequestId,
        duplicate_of_request_id: duplicateOfRequestId,
        action: risk.action,
        metadata: {
          visit_type_key: payload.visit_type_key || null,
          status: payload.status || null,
          has_message: Boolean(payload.message),
          active_blocks: Array.isArray(risk.activeBlocks)
            ? risk.activeBlocks.map(block => ({ id: block.id, type: block.subject_type, reason: block.reason, expires_at: block.expires_at }))
            : [],
        },
      },
      headers: { Prefer: 'return=minimal' },
    });
  } catch (err) {
    console.error('[lead-security:signal]', err?.message || err);
  }
}

export function applySecurityToPayload(payload, risk, context) {
  return {
    ...payload,
    ...securityFields({ risk, context }),
    duplicate_of_request_id: risk.duplicate?.id || payload.duplicate_of_request_id || null,
    duplicate_reason: risk.duplicate ? risk.reasons.join(', ') : payload.duplicate_reason || null,
    match_summary: {
      ...(payload.match_summary || {}),
      lead_security: {
        action: risk.action,
        reasons: risk.reasons,
        duplicate_id: risk.duplicate?.id || null,
        active_blocks: Array.isArray(risk.activeBlocks)
          ? risk.activeBlocks.map(block => ({ id: block.id, type: block.subject_type, reason: block.reason, expires_at: block.expires_at }))
          : [],
      },
    },
    website_payload_raw: {
      ...(payload.website_payload_raw || {}),
      lead_security: {
        action: risk.action,
        score: risk.score,
        reasons: risk.reasons,
        active_blocks: Array.isArray(risk.activeBlocks)
          ? risk.activeBlocks.map(block => ({ id: block.id, type: block.subject_type, reason: block.reason, expires_at: block.expires_at }))
          : [],
      },
    },
  };
}

export function shouldSkipInsertForDuplicate(risk, intent) {
  if (!risk.duplicate) return false;
  if (intent === 'callback') return true;
  if (intent === 'urgent') return risk.score >= 70;
  return risk.action === 'merge_duplicate' || risk.action === 'soft_block';
}

function addRisk(risk, points, reason) {
  risk.score += points;
  if (!risk.reasons.includes(reason)) risk.reasons.push(reason);
}

async function loadExistingRequests(supabaseFetch, { phone, phoneHash, deviceIdHash, ipPrefixHash, since }) {
  if (!supabaseFetch) return [];
  const clauses = [];
  if (phone) clauses.push(`owner_phone.eq.${escapePostgrest(phone)}`);
  if (phoneHash) clauses.push(`phone_hash.eq.${escapePostgrest(phoneHash)}`);
  if (deviceIdHash) clauses.push(`device_id_hash.eq.${escapePostgrest(deviceIdHash)}`);
  if (ipPrefixHash) clauses.push(`ip_prefix_hash.eq.${escapePostgrest(ipPrefixHash)}`);
  if (!clauses.length) return [];

  try {
    const path = [
      'appointment_requests',
      '?select=id,owner_name,owner_phone,phone_hash,device_id_hash,ip_prefix_hash,patient_name,visit_type_key,preferred_at,status,created_at',
      `&created_at=gte.${encodeURIComponent(since)}`,
      `&status=in.(${ACTIVE_STATUSES})`,
      `&or=${encodeURIComponent(`(${clauses.join(',')})`)}`,
      '&order=created_at.desc',
      '&limit=25',
    ].join('');
    const rows = await supabaseFetch(path);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[lead-security:existing]', err?.message || err);
    return [];
  }
}

async function loadActiveBlocks(supabaseFetch, { phoneHash, deviceIdHash, ipPrefixHash }) {
  if (!supabaseFetch) return [];
  const checks = [
    ['phone', phoneHash],
    ['device', deviceIdHash],
    ['ip', ipPrefixHash],
  ].filter(([, hash]) => Boolean(hash));

  if (!checks.length) return [];

  try {
    const now = encodeURIComponent(new Date().toISOString());
    const rows = await Promise.all(checks.map(async ([type, hash]) => {
      const path = [
        'lead_blocklist',
        '?select=id,subject_type,reason,expires_at,source_request_id',
        `&subject_type=eq.${encodeURIComponent(type)}`,
        `&subject_hash=eq.${escapePostgrest(hash)}`,
        `&expires_at=gt.${now}`,
        '&order=expires_at.desc',
        '&limit=3',
      ].join('');
      return supabaseFetch(path);
    }));
    return rows.flat().filter(Boolean);
  } catch (err) {
    console.error('[lead-security:blocklist]', err?.message || err);
    return [];
  }
}

function samePhone(item, phone, phoneHash) {
  return (phone && normalizePhone(item.owner_phone) === phone) || (phoneHash && item.phone_hash === phoneHash);
}

function pickDuplicate(items, payload, intent) {
  return items.find(item => (
    intent === 'urgent'
      ? item.visit_type_key === 'urgenta'
      : item.visit_type_key === payload.visit_type_key || item.status === 'new' || item.status === 'in_review'
  )) || items[0] || null;
}

function normalizeIpPrefix(ip = '') {
  const clean = String(ip || '').trim();
  if (!clean || clean === 'unknown') return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) {
    return clean.split('.').slice(0, 3).join('.') + '.0/24';
  }
  if (clean.includes(':')) {
    return clean.split(':').slice(0, 4).join(':') + '::/64';
  }
  return clean.slice(0, 80);
}

function hashValue(value = '') {
  const clean = String(value || '').trim();
  if (!clean) return null;
  const pepper = process.env.LEAD_SECURITY_PEPPER || process.env.INTERNAL_API_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!pepper) throw new Error('Lead security pepper is not configured');
  return crypto.createHmac('sha256', pepper).update(clean).digest('hex');
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLowInformationText(value = '') {
  const clean = normalizeText(value);
  if (!clean) return false;
  if (clean.length <= 6) return true;
  if (/^(test|aaa+|asdf|qwerty|\d+)$/i.test(clean)) return true;
  return /(.)\1{5,}/.test(clean);
}

function escapePostgrest(value = '') {
  return encodeURIComponent(String(value).replace(/"/g, ''));
}
