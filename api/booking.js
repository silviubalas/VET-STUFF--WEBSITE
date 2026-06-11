import { enforceOrigin, getClientIp, isHoneypotFilled, rateLimit, verifyTurnstile } from './_security.js';
import { notifyFormspree } from './_notifications.js';

const DEFAULT_TIMEZONE = 'Europe/Bucharest';
const WEEKDAY_IDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_DAYS = 21;
const DEFAULT_DAYS = 14;

const DEFAULT_DOCTORS = [
  { id: 'doc-balas', name: 'Dr. Balaș Silviu-Constantin', specialization: 'Ortopedie + Chirurgie' },
];

const DEFAULT_SERVICES = [
  { key: 'consultatie_generala', label: 'Consultație generală', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'vaccinare', label: 'Vaccinare', category: 'Vaccinări', duration_minutes: 30 },
  { key: 'deparazitare_interna', label: 'Deparazitare internă', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'deparazitare_externa', label: 'Deparazitare externă', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'analize', label: 'Analize laborator', category: 'Imagistică/Diagnostic', duration_minutes: 30 },
  { key: 'ecografie_toracica', label: 'Imagistică / ecografie', category: 'Imagistică/Diagnostic', duration_minutes: 30 },
  { key: 'consultatie_chirurgie', label: 'Chirurgie', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'dermatologie', label: 'Dermatologie', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'oftalmologie', label: 'Oftalmologie', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'ortopedie', label: 'Ortopedie', category: 'Consultații/Examene', duration_minutes: 30 },
  { key: 'stomatologie', label: 'Stomatologie', category: 'Proceduri medicale', duration_minutes: 60 },
];

const PUBLIC_SERVICE_KEYS = new Set(DEFAULT_SERVICES.map(service => service.key));

const DEFAULT_SCHEDULE_DAYS = [
  { id: 'monday', label: 'Luni', active: true, intervals: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
  { id: 'tuesday', label: 'Marți', active: true, intervals: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
  { id: 'wednesday', label: 'Miercuri', active: true, intervals: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
  { id: 'thursday', label: 'Joi', active: true, intervals: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
  { id: 'friday', label: 'Vineri', active: true, intervals: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
  { id: 'saturday', label: 'Sâmbătă', active: true, intervals: [{ start: '09:00', end: '13:00' }] },
  { id: 'sunday', label: 'Duminică', active: false, intervals: [] },
];

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!enforceOrigin(req, res)) return;

  if (req.method === 'GET') {
    if (!rateLimit(req, res, 'booking-slots', { max: 80, windowMs: 15 * 60 * 1000 })) return;
    return handleGet(req, res);
  }

  if (!rateLimit(req, res, 'booking-request', { max: 8, windowMs: 15 * 60 * 1000 })) return;
  if (isHoneypotFilled(req.body || {})) return res.status(200).json({ ok: true });

  const captcha = await verifyTurnstile(req.body?.turnstileToken, getClientIp(req));
  if (!captcha.ok) return res.status(400).json({ error: captcha.error || 'Captcha failed' });

  return handlePost(req, res);
}

async function handleGet(req, res) {
  const config = supabaseConfig();
  if (!config.configured) {
    return res.status(503).json({
      ok: false,
      configured: false,
      error: 'Booking calendar is not configured',
      services: DEFAULT_SERVICES,
      doctors: DEFAULT_DOCTORS,
      days: [],
    });
  }

  try {
    const context = await loadBookingContext(req.query || {});
    return res.status(200).json({ ok: true, configured: true, ...context });
  } catch (err) {
    console.error('[booking:get]', err?.message || err);
    return res.status(502).json({ ok: false, error: 'Calendar unavailable' });
  }
}

async function handlePost(req, res) {
  const config = supabaseConfig();
  if (!config.configured) {
    return res.status(503).json({ ok: false, error: 'Booking calendar is not configured' });
  }

  const body = sanitizeBookingRequest(req.body || {});
  if (!body.ok) return res.status(400).json({ ok: false, error: body.error });

  try {
    const date = zonedDateKey(new Date(body.value.preferredAt), DEFAULT_TIMEZONE);
    const context = await loadBookingContext({
      date,
      days: '1',
      service: body.value.serviceKey,
    });
    const matchingSlot = context.days
      .flatMap(day => day.slots)
      .find(slot => (
        slot.doctorId === body.value.doctorId &&
        Math.abs(new Date(slot.start).getTime() - new Date(body.value.preferredAt).getTime()) < 60 * 1000
      ));

    if (!matchingSlot) {
      return res.status(409).json({ ok: false, error: 'Slotul nu mai este disponibil. Alege alt interval.' });
    }

    const payload = {
      owner_name: body.value.ownerName,
      owner_phone: body.value.phone,
      owner_email: body.value.email || null,
      patient_name: body.value.patientName,
      patient_species: body.value.species,
      visit_type_key: matchingSlot.serviceKey,
      visit_type_label: matchingSlot.serviceLabel,
      preferred_at: matchingSlot.start,
      doctor_id: matchingSlot.doctorId,
      doctor_name: matchingSlot.doctorName,
      duration_minutes: matchingSlot.durationMinutes,
      message: body.value.message || null,
      source: 'website',
      status: 'new',
    };

    const created = await supabaseFetch('appointment_requests', {
      method: 'POST',
      body: payload,
      headers: { Prefer: 'return=representation' },
    });
    const request = Array.isArray(created) ? created[0] : created;

    notifyClinicLead({ ...payload, request_id: request?.id }).catch(err => {
      console.error('[booking:notify]', err?.message || err);
    });

    syncAirtableLead({ ...payload, request_id: request?.id }).catch(err => {
      console.error('[booking:airtable]', err?.message || err);
    });

    return res.status(200).json({
      ok: true,
      requestId: request?.id || null,
      message: 'Cererea a fost trimisă. Echipa VET STUFF o confirmă din CRM.',
    });
  } catch (err) {
    console.error('[booking:post]', err?.message || err);
    return res.status(502).json({ ok: false, error: 'Cererea nu a putut fi trimisă.' });
  }
}

async function loadBookingContext(query) {
  const clinic = await loadClinicSettings();
  const timezone = clinic.timezone || DEFAULT_TIMEZONE;
  const daysCount = clampInt(query.days, 1, MAX_DAYS, DEFAULT_DAYS);
  const startDate = validDateKey(query.date) || zonedDateKey(new Date(), timezone);
  const dateKeys = nextDateKeys(startDate, daysCount);
  const services = await loadServices();
  const selectedService = services.find(service => service.key === query.service) || services[0] || DEFAULT_SERVICES[0];
  const doctors = await loadDoctors();
  const from = zonedDateTimeToUtc(dateKeys[0], 0, timezone).toISOString();
  const to = zonedDateTimeToUtc(addDays(dateKeys[dateKeys.length - 1], 1), 0, timezone).toISOString();
  const [appointments, heldRequests] = await Promise.all([
    loadAppointments(from, to),
    loadHeldRequests(from, to),
  ]);

  const days = dateKeys.map(dateKey => buildDayAvailability({
    dateKey,
    clinic,
    timezone,
    doctors,
    service: selectedService,
    appointments,
    heldRequests,
  }));

  return {
    timezone,
    services,
    selectedServiceKey: selectedService.key,
    doctors,
    days,
  };
}

async function loadClinicSettings() {
  const rows = await supabaseFetch('clinic_settings?select=*&order=updated_at.desc&limit=1');
  return Array.isArray(rows) && rows[0] ? rows[0] : {};
}

async function loadDoctors() {
  let rows;
  try {
    rows = await supabaseFetch([
      'clinic_doctors',
      '?select=id,name,specialization,active,staff_bookable,online_booking,sort_order',
      '&active=eq.true',
      '&staff_bookable=eq.true',
      '&online_booking=eq.true',
      '&order=sort_order.asc',
      '&order=name.asc',
    ].join(''));
  } catch (err) {
    const message = String(err?.message || '');
    if (!message.includes('staff_bookable') && !message.includes('online_booking')) throw err;
    rows = await supabaseFetch([
      'clinic_doctors',
      '?select=id,name,specialization,active,sort_order',
      '&active=eq.true',
      '&order=sort_order.asc',
      '&order=name.asc',
    ].join(''));
  }

  const doctors = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.name && row.active !== false && row.staff_bookable !== false && row.online_booking !== false)
    .map(row => ({
      id: row.id,
      name: row.name,
      specialization: row.specialization || 'Medic veterinar',
    }));

  return doctors.length ? doctors : DEFAULT_DOCTORS;
}

async function loadServices() {
  const rows = await supabaseFetch('clinic_visit_types?select=key,label,category,duration_minutes,hidden,sort_order&hidden=eq.false&order=sort_order.asc&order=label.asc');
  const mapped = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.key && row?.label)
    .map(row => ({
      key: row.key,
      label: row.label,
      category: row.category || 'Servicii',
      duration_minutes: Math.max(5, Number(row.duration_minutes) || 30),
    }));

  const publicMapped = mapped.filter(service => PUBLIC_SERVICE_KEYS.has(service.key));
  const source = publicMapped.length ? publicMapped : mapped;
  const merged = mergeServiceDefaults(source);
  return merged.length ? merged : DEFAULT_SERVICES;
}

async function loadAppointments(from, to) {
  return supabaseFetch([
    'appointments',
    '?select=id,doctor,scheduled_at,duration_minutes,status',
    `&scheduled_at=gte.${encodeURIComponent(from)}`,
    `&scheduled_at=lt.${encodeURIComponent(to)}`,
    '&status=neq.cancelled',
  ].join(''));
}

async function loadHeldRequests(from, to) {
  return supabaseFetch([
    'appointment_requests',
    '?select=id,doctor_name,preferred_at,duration_minutes,status',
    `&preferred_at=gte.${encodeURIComponent(from)}`,
    `&preferred_at=lt.${encodeURIComponent(to)}`,
    '&status=in.(new,accepted)',
  ].join(''));
}

function buildDayAvailability({ dateKey, clinic, timezone, doctors, service, appointments, heldRequests }) {
  const intervals = daySchedule(clinic, dateKey);
  const leadMinutes = Math.max(0, Number(clinic.preferences?.firstAppointmentLeadMinutes) || 60);
  const step = normalizeStep(clinic.preferences?.bookingRoundMinutes);
  const now = Date.now();
  const slots = [];

  if (intervals.length) {
    for (const doctor of doctors) {
      const busy = [
        ...(appointments || [])
          .filter(item => sameDoctor(item.doctor, doctor.name))
          .map(item => ({
            start: new Date(item.scheduled_at).getTime(),
            duration: Number(item.duration_minutes) || 30,
          })),
        ...(heldRequests || [])
          .filter(item => sameDoctor(item.doctor_name, doctor.name))
          .map(item => ({
            start: new Date(item.preferred_at).getTime(),
            duration: Number(item.duration_minutes) || 30,
          })),
      ];

      for (const interval of intervals) {
        for (let minute = ceilToStep(interval.startMin, step); minute + service.duration_minutes <= interval.endMin; minute += step) {
          const startDate = zonedDateTimeToUtc(dateKey, minute, timezone);
          const startMs = startDate.getTime();
          if (startMs < now + leadMinutes * 60000) continue;
          if (busy.some(item => rangesOverlap(startMs, service.duration_minutes, item.start, item.duration))) continue;

          const endDate = new Date(startMs + service.duration_minutes * 60000);
          slots.push({
            id: `${dateKey}-${doctor.id}-${minute}`,
            date: dateKey,
            time: minutesToClock(minute),
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            doctorId: doctor.id,
            doctorName: doctor.name,
            doctorSpecialization: doctor.specialization,
            serviceKey: service.key,
            serviceLabel: service.label,
            durationMinutes: service.duration_minutes,
          });
        }
      }
    }
  }

  slots.sort((a, b) => new Date(a.start) - new Date(b.start) || a.doctorName.localeCompare(b.doctorName, 'ro'));

  return {
    date: dateKey,
    label: formatDateLabel(dateKey, timezone),
    shortLabel: formatShortDateLabel(dateKey, timezone),
    slots: slots.slice(0, 80),
  };
}

function daySchedule(clinic, dateKey) {
  const date = parseDateKey(dateKey);
  const dayId = WEEKDAY_IDS[date.getUTCDay()];
  const regularDay = normalizeScheduleDays(clinic.schedule_days).find(day => day.id === dayId);
  const exception = matchingScheduleException(clinic.schedule_exceptions, dateKey);
  const source = exception || regularDay;
  if (!source || source.active === false) return [];
  return normalizeIntervals(source.intervals);
}

function normalizeScheduleDays(scheduleDays) {
  const byId = new Map((Array.isArray(scheduleDays) ? scheduleDays : []).map(day => [day.id, day]));
  return DEFAULT_SCHEDULE_DAYS.map(day => {
    const stored = byId.get(day.id) || {};
    return {
      ...day,
      active: typeof stored.active === 'boolean' ? stored.active : day.active,
      intervals: Array.isArray(stored.intervals) && stored.intervals.length ? stored.intervals : day.intervals,
    };
  });
}

function matchingScheduleException(exceptions, dateKey) {
  const matches = (Array.isArray(exceptions) ? exceptions : []).filter(exception => scheduleExceptionApplies(exception, dateKey));
  return matches.find(exception => (exception.recurrence || 'none') === 'none') || matches[0] || null;
}

function scheduleExceptionApplies(exception, dateKey) {
  if (!exception?.date) return false;
  const source = parseDateKey(exception.date);
  const target = parseDateKey(dateKey);
  if (!source || !target) return false;
  const recurrence = exception.recurrence || 'none';
  if (recurrence === 'yearly') return source.getUTCMonth() === target.getUTCMonth() && source.getUTCDate() === target.getUTCDate();
  if (recurrence === 'monthly') return source.getUTCDate() === target.getUTCDate();
  return exception.date === dateKey;
}

function normalizeIntervals(intervals) {
  const normalized = (Array.isArray(intervals) ? intervals : [])
    .map(interval => {
      const startMin = parseClock(interval?.start, null);
      const endMin = parseClock(interval?.end, null);
      if (startMin == null || endMin == null || endMin <= startMin) return null;
      return { startMin, endMin };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMin - b.startMin);

  return normalized.reduce((merged, interval) => {
    const last = merged[merged.length - 1];
    if (!last || interval.startMin > last.endMin) {
      merged.push({ ...interval });
      return merged;
    }
    last.endMin = Math.max(last.endMin, interval.endMin);
    return merged;
  }, []);
}

function sanitizeBookingRequest(body) {
  const ownerName = cleanString(body.ownerName, 120);
  const phone = cleanPhone(body.phone);
  const email = cleanEmail(body.email);
  const patientName = cleanString(body.patientName, 100);
  const species = cleanSpecies(body.species);
  const serviceKey = cleanKey(body.serviceKey);
  const doctorId = cleanKey(body.doctorId, 80);
  const preferredAt = cleanIso(body.preferredAt);
  const message = cleanString(body.message, 1600, true);

  if (!ownerName) return { ok: false, error: 'Numele este obligatoriu.' };
  if (!phone) return { ok: false, error: 'Telefonul este obligatoriu.' };
  if (body.email && !email) return { ok: false, error: 'Email invalid.' };
  if (!patientName) return { ok: false, error: 'Numele animalului este obligatoriu.' };
  if (!serviceKey) return { ok: false, error: 'Serviciul este obligatoriu.' };
  if (!doctorId) return { ok: false, error: 'Medicul este obligatoriu.' };
  if (!preferredAt) return { ok: false, error: 'Intervalul ales este invalid.' };

  return {
    ok: true,
    value: {
      ownerName,
      phone,
      email,
      patientName,
      species,
      serviceKey,
      doctorId,
      preferredAt,
      message,
    },
  };
}

async function notifyClinicLead(fields) {
  return notifyFormspree('Cerere programare online - VET STUFF', {
    'ID cerere': fields.request_id || '',
    'Nume proprietar': fields.owner_name,
    'Telefon': fields.owner_phone,
    'Email': fields.owner_email || '',
    'Nume animal': fields.patient_name,
    'Tip animal': fields.patient_species || '',
    'Serviciu': fields.visit_type_label || fields.visit_type_key || '',
    'Medic': fields.doctor_name || '',
    'Interval ales': fields.preferred_at,
    'Status': 'Cerere nouă în CRM',
    'Mesaj': fields.message || '',
  });
}

async function syncAirtableLead(fields) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return { ok: false, skipped: true };

  const airtableRes = await fetch('https://api.airtable.com/v0/appGhcW1B4iDA4cUY/' + encodeURIComponent('Programari'), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        Name: fields.owner_name,
        Telefon: fields.owner_phone,
        Email: fields.owner_email || undefined,
        'Nume animal': fields.patient_name,
        'Tip animal': fields.patient_species || undefined,
        Serviciu: fields.visit_type_label || fields.visit_type_key || undefined,
        'Data preferată': String(fields.preferred_at || '').slice(0, 10),
        Descriere: [
          fields.message,
          fields.doctor_name ? `Medic ales: ${fields.doctor_name}` : '',
          fields.request_id ? `Cerere CRM: ${fields.request_id}` : '',
        ].filter(Boolean).join('\n'),
      },
    }),
  });

  return { ok: airtableRes.ok, status: airtableRes.status };
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

function mergeServiceDefaults(services) {
  const byKey = new Map(services.map(service => [service.key, service]));
  const ordered = DEFAULT_SERVICES.map(service => byKey.get(service.key) || service);
  const extras = services.filter(service => !PUBLIC_SERVICE_KEYS.has(service.key));
  return [...ordered, ...extras].filter(service => service?.key && service?.label);
}

function sameDoctor(a, b) {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function rangesOverlap(aStart, aDuration, bStart, bDuration) {
  const aEnd = aStart + aDuration * 60000;
  const bEnd = bStart + bDuration * 60000;
  return aStart < bEnd && bStart < aEnd;
}

function parseClock(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

function minutesToClock(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function ceilToStep(value, step) {
  return Math.ceil(value / step) * step;
}

function normalizeStep(value) {
  const step = Number(value) || 30;
  return [5, 10, 15, 30].includes(step) ? step : 30;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

function parseDateKey(value) {
  const key = validDateKey(value);
  if (!key) return null;
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(dateKey, days) {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextDateKeys(startDate, days) {
  return Array.from({ length: days }, (_, index) => addDays(startDate, index));
}

function formatDateLabel(dateKey, timezone) {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(zonedDateTimeToUtc(dateKey, 12 * 60, timezone));
}

function formatShortDateLabel(dateKey, timezone) {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(zonedDateTimeToUtc(dateKey, 12 * 60, timezone)).replace('.', '');
}

function zonedDateKey(date, timezone) {
  const parts = dateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedDateTimeToUtc(dateKey, minute, timezone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes, 0);
  const firstOffset = timezoneOffsetMs(new Date(utcGuess), timezone);
  const adjusted = utcGuess - firstOffset;
  const secondOffset = timezoneOffsetMs(new Date(adjusted), timezone);
  return new Date(utcGuess - secondOffset);
}

function timezoneOffsetMs(date, timezone) {
  const parts = dateParts(date, timezone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function dateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function cleanString(value, max, optional = false) {
  if (value == null || value === '') return optional ? '' : '';
  return String(value).trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanPhone(value) {
  const phone = String(value || '').trim().replace(/\s+/g, '');
  if (!/^(\+40|0)[0-9]{9}$/.test(phone)) return '';
  return phone.startsWith('0') ? `+40${phone.slice(1)}` : phone;
}

function cleanEmail(value) {
  if (!value) return '';
  const email = String(value).trim().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanKey(value, max = 80) {
  const clean = String(value || '').trim().slice(0, max);
  return /^[a-zA-Z0-9_.:-]+$/.test(clean) ? clean : '';
}

function cleanIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function cleanSpecies(value) {
  const clean = String(value || '').toLowerCase();
  if (clean.includes('caine') || clean.includes('câine')) return 'caine';
  if (clean.includes('pisica') || clean.includes('pisică')) return 'pisica';
  return cleanString(value || 'exotic', 40) || 'exotic';
}
