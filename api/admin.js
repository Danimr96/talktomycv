import { sbFetch, json } from './_shared.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  const expected = process.env.ADMIN_TOKEN || '';
  const got = typeof b.token === 'string' ? b.token : '';
  if (expected.length < 20 || got !== expected) return json({ error: 'unauthorized' }, 401);

  try {
    if (b.view === 'session' && typeof b.session_id === 'string' && /^[0-9a-f-]{36}$/.test(b.session_id)) {
      const messages = await sbFetch(
        `messages?session_id=eq.${b.session_id}&select=role,content,tokens,created_at&order=id.asc&limit=200`
      );
      return json({ messages });
    }
    const sessions = await sbFetch(
      `sessions?select=id,created_at,msg_count,tokens_in,tokens_out,cost_eur,status,recruiters(nombre,empresa,email,puesto,banda,modalidad,jd)&order=created_at.desc&limit=200`
    );
    const daily = await sbFetch(`daily_spend?select=day,cost_eur&order=day.desc&limit=30`);
    return json({ sessions, daily });
  } catch {
    return json({ error: 'db error' }, 502);
  }
}
