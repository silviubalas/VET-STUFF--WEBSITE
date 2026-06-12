export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) {
    return res.status(503).json({ ok: false, error: 'Configurația publică nu este disponibilă.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, url, anonKey });
}
