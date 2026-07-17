/* Utilidades compartidas — los archivos con guion bajo no se exponen como rutas. */

export async function sbFetch(path, { method = 'GET', body, prefer } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

/* tope superior (k€) de cada banda del gate */
export const BAND_TOP = { '<60k €': 60, '60–75k €': 75, '75–90k €': 90, '90–110k €': 110, '>110k €': 999 };

/* precios aproximados USD/Mtok (input/output) + conversión a EUR */
const PRICE = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
};
export function costEUR(model, tin, tout) {
  const p = PRICE[model] || PRICE['claude-sonnet-5'];
  return ((tin * p.in + tout * p.out) / 1e6) * 0.92;
}
