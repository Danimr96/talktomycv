import { sbFetch, json, sha256, todayISO } from './_shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'JSON no válido.' }, 400); }

  const S = v => (typeof v === 'string' ? v.trim() : '');
  const nombre = S(b.nombre), empresa = S(b.empresa), email = S(b.email).toLowerCase(),
        puesto = S(b.puesto), banda = S(b.banda), modalidad = S(b.modalidad),
        jd = S(b.jd).slice(0, 15000);

  if (!nombre || !empresa || !email || !puesto || !banda || !modalidad)
    return json({ error: 'Faltan campos obligatorios.' }, 400);
  if (b.consent !== true)
    return json({ error: 'Necesito tu consentimiento para tratar estos datos.' }, 400);
  if ([nombre, empresa, puesto].some(x => x.length > 120) || banda.length > 20 || modalidad.length > 30)
    return json({ error: 'Algún campo es demasiado largo.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200)
    return json({ error: 'El email no parece válido.' }, 400);

  try {
    /* kill-switch de gasto diario */
    const cap = parseFloat(process.env.DAILY_CAP_EUR || '2');
    const spend = await sbFetch(`daily_spend?day=eq.${todayISO()}&select=cost_eur`);
    if (spend && spend[0] && parseFloat(spend[0].cost_eur) >= cap) return json({ error: 'sleep' }, 503);

    /* rate limiting: 3 sesiones/día por email, 6 por red */
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const ipHash = await sha256(ip + (process.env.IP_SALT || ''));
    const since = new Date(Date.now() - 864e5).toISOString();
    const byEmail = await sbFetch(`recruiters?email=eq.${encodeURIComponent(email)}&created_at=gte.${since}&select=id`);
    if (byEmail.length >= 3)
      return json({ error: 'Límite de sesiones diarias alcanzado con este email. Vuelve mañana o usa el botón de email.' }, 429);
    const byIp = await sbFetch(`recruiters?ip_hash=eq.${ipHash}&created_at=gte.${since}&select=id`);
    if (byIp.length >= 6)
      return json({ error: 'Demasiadas sesiones desde esta red hoy. Vuelve mañana.' }, 429);

    const rows = await sbFetch('recruiters', {
      method: 'POST', prefer: 'return=representation',
      body: {
        nombre, empresa, email, puesto, banda, modalidad, jd: jd || null,
        consent: true, consent_at: new Date().toISOString(),
        ip_hash: ipHash, user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
      },
    });
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
    await sbFetch('sessions', { method: 'POST', body: { recruiter_id: rows[0].id, token } });
    return json({ token });
  } catch (e) {
    return json({ error: 'El registro no está disponible ahora mismo. Prueba en unos minutos o usa el botón de email.' }, 502);
  }
}
