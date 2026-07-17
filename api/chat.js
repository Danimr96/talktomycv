import { sbFetch, json, todayISO, BAND_TOP, costEUR } from './_shared.js';
import { STATIC_PROMPT } from './_prompt.js';

export const config = { runtime: 'edge' };

const BUDGET_TOKENS = 30000;  /* presupuesto por sesión */
const MAX_MSGS = 25;          /* turnos por sesión */
const MAX_INPUT = 4000;       /* caracteres por mensaje (una JD cabe) */

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'JSON no válido.' }, 400); }
  const token = typeof b.token === 'string' ? b.token : '';
  const userMsg = (typeof b.message === 'string' ? b.message : '').trim().slice(0, MAX_INPUT);
  if (!/^[0-9a-f]{48}$/.test(token) || !userMsg) return json({ error: 'Petición no válida.' }, 400);

  let sess, spendToday = 0;
  try {
    const rows = await sbFetch(`sessions?token=eq.${token}&select=*,recruiters(*)`);
    sess = rows && rows[0];
    if (!sess || sess.status !== 'active') return json({ error: 'invalid_session' }, 401);
    if (sess.msg_count >= MAX_MSGS || (sess.tokens_in + sess.tokens_out) >= BUDGET_TOKENS) {
      await sbFetch(`sessions?id=eq.${sess.id}`, { method: 'PATCH', body: { status: 'exhausted' } });
      return json({ error: 'budget' }, 402);
    }
    const cap = parseFloat(process.env.DAILY_CAP_EUR || '2');
    const spend = await sbFetch(`daily_spend?day=eq.${todayISO()}&select=cost_eur`);
    spendToday = spend && spend[0] ? parseFloat(spend[0].cost_eur) : 0;
    if (spendToday >= cap) return json({ error: 'sleep' }, 503);
  } catch { return json({ error: 'El agente no está disponible ahora mismo.' }, 502); }

  const r = sess.recruiters;
  const floor = parseInt(process.env.SALARY_FLOOR || '0', 10);
  const lowBand = floor > 0 && (BAND_TOP[r.banda] || 999) <= floor;
  const dynamic =
    `<recruiter>\nNombre: ${r.nombre}\nEmpresa: ${r.empresa}\nPuesto que cubren: ${r.puesto}\n` +
    `Banda salarial indicada: ${r.banda}\nModalidad: ${r.modalidad}\n` +
    `Job description: ${r.jd || 'no proporcionada'}\n</recruiter>\n` +
    (lowBand
      ? 'NOTA INTERNA (no la cites literalmente): la banda salarial indicada está por debajo de las expectativas de Dani. En tu PRIMERA respuesta menciónalo con elegancia y sin dar ninguna cifra propia, invitando a seguir solo si hay flexibilidad. No lo repitas en mensajes posteriores.\n'
      : '');

  const history = await sbFetch(`messages?session_id=eq.${sess.id}&select=role,content&order=id.asc&limit=40`);
  const messages = [...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: userMsg }];

  /* Sonnet para fit-check (mensaje largo tipo JD o primera respuesta con JD del gate); Haiku para el resto */
  const model = (userMsg.length > 600 || (history.length === 0 && (r.jd || '').length > 200))
    ? 'claude-sonnet-5'
    : 'claude-haiku-4-5-20251001';

  const up = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      stream: true,
      system: [
        { type: 'text', text: STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamic },
      ],
      messages,
    }),
  });
  if (!up.ok) return json({ error: 'El agente no está disponible ahora mismo.' }, 502);

  const enc = new TextEncoder(), dec = new TextDecoder();
  let assistant = '', tin = 0, tout = 0, buf = '', cacheRead = 0, cacheWrite = 0;

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = obj => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const reader = up.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
              assistant += ev.delta.text;
              send({ t: ev.delta.text });
            } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
              const u = ev.message.usage;
              cacheRead = u.cache_read_input_tokens || 0;
              cacheWrite = u.cache_creation_input_tokens || 0;
              tin = (u.input_tokens || 0) + cacheWrite + cacheRead;
            } else if (ev.type === 'message_delta' && ev.usage) {
              tout = ev.usage.output_tokens || tout;
            }
          }
        }
        /* persistir antes de cerrar el stream */
        const cost = costEUR(model, tin, tout);
        const totIn = sess.tokens_in + tin, totOut = sess.tokens_out + tout;
        const totCost = parseFloat(sess.cost_eur) + cost;
        await sbFetch('messages', {
          method: 'POST',
          body: [
            { session_id: sess.id, role: 'user', content: userMsg, tokens: tin },
            { session_id: sess.id, role: 'assistant', content: assistant, tokens: tout },
          ],
        });
        await sbFetch(`sessions?id=eq.${sess.id}`, {
          method: 'PATCH',
          body: { tokens_in: totIn, tokens_out: totOut, cost_eur: totCost, msg_count: sess.msg_count + 1, last_at: new Date().toISOString() },
        });
        await sbFetch('daily_spend?on_conflict=day', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
          body: { day: todayISO(), cost_eur: spendToday + cost },
        });
        send({ usage: {
          model, tin, tout, cost_eur: cost,
          cache_read: cacheRead, cache_write: cacheWrite,
          session_tokens: totIn + totOut, session_cost: totCost,
          budget: BUDGET_TOKENS, msgs_used: sess.msg_count + 1, msgs_max: MAX_MSGS,
        } });
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      } catch {
        send({ error: 'stream' });
      }
      ctrl.close();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
