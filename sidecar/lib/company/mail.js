'use strict';
const crypto = require('node:crypto');
const { uid, DAY } = require('./util');

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const b64 = (s) => Buffer.from(String(s)).toString('base64url');
const unb64 = (s) => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } };
/** Kinds that are billing/service messages (may go out after a payment problem even if the person opted out of marketing). */
const TRANSACTIONAL = new Set(['delivery', 'billing', 'owner_digest']);

/**
 * The outbound mail layer of the company. One queue, one place where the laws are enforced in code:
 *   - nothing is sent until a human approved it (batch approval in the daily digest), unless the owner explicitly listed a
 *     sequence in settings.mail.auto_send;
 *   - a hard daily send limit, a send window (fast-lane replies bypass the window, never the limit);
 *   - an opt-out footer + one-click unsubscribe link, and an unsubscribe list that is checked on every send;
 *   - no provider configured means messages wait in the queue as "manual": nothing is faked.
 * Providers ("rails") are pluggable like the payment rails: registerMailer(name, async (msg, cfg) => ({ id })).
 */
function makeMail(ctx) {
  const Q = () => ctx.db.get('mail', []);
  const U = () => ctx.db.get('unsubscribed', {});
  const cfg = () => ({ apiKey: ctx.secrets._get('resend_api_key'), from: ctx.secrets._get('mail_from'), replyTo: ctx.secrets._get('mail_reply_to'),
    footer: ctx.secrets._get('mail_footer') || ctx.settings().mail.footer || '', owner: ctx.secrets._get('owner_email') || ctx.settings().mail.owner_email || '' });

  // ---- providers
  const rails = {
    manual: async () => ({ manual: true }),
    resend: async (m, c) => {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ from: c.from, to: [m.to], subject: m.subject, text: m.text, ...(c.replyTo ? { reply_to: c.replyTo } : {}), ...(m.unsub ? { headers: { 'List-Unsubscribe': `<${m.unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) }) });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`Resend: ${j.message || j.error || res.status}`); return { id: j.id };
    },
  };
  const registerMailer = (name, fn) => { rails[name] = fn; };
  const provider = () => { const p = ctx.settings().mail.provider; if (p && p !== 'auto') return rails[p] ? p : 'manual'; const c = cfg(); return c.apiKey && c.from && rails.resend ? 'resend' : 'manual'; };
  const configured = () => provider() !== 'manual';

  // ---- public URL for links (tunnel > setting > local); set by tunnel.js
  const publicUrl = () => (ctx.publicUrl ? ctx.publicUrl() : '') || `http://127.0.0.1:${ctx.settings().port || 8787}`;
  const unsubToken = (venture_id, email) => { const v = ctx.ventures.get(venture_id); return crypto.createHmac('sha256', (v && v.lead_token) || 'none').update(String(email).toLowerCase()).digest('hex').slice(0, 24); };
  const unsubLink = (venture_id, email) => `${publicUrl()}/hooks/unsub/${venture_id}/${unsubToken(venture_id, email)}/${b64(String(email).toLowerCase())}`;
  function verifyUnsub(venture_id, token, encodedEmail) {
    const email = unb64(encodedEmail); if (!EMAIL.test(email)) return null;
    const a = Buffer.from(String(token)), b = Buffer.from(unsubToken(venture_id, email)); return a.length === b.length && crypto.timingSafeEqual(a, b) ? email : null;
  }
  const isUnsubscribed = (email) => Boolean(U()[String(email || '').toLowerCase()]);
  function unsubscribe(email, why = 'requested') {
    const e = String(email || '').trim().toLowerCase(); if (!EMAIL.test(e)) return false;
    U()[e] = { ts: ctx.now(), why }; ctx.db.save('unsubscribed');
    for (const m of Q()) if (m.to.toLowerCase() === e && ['draft', 'approved'].includes(m.status) && !TRANSACTIONAL.has(m.kind)) { m.status = 'skipped'; m.error = 'recipient opted out'; }
    ctx.db.save('mail'); ctx.emit('mail.unsubscribed', { email: e }); return true;
  }

  // ---- the queue
  const autoSend = (m) => (ctx.settings().mail.auto_send || []).includes(m.sequence || m.kind);
  /**
   * Queue a message. It is a DRAFT until approved (the daily digest approves in a batch). `flags` lists reasons a message must be
   * read individually instead of being bulk-approved.
   */
  function queue(o) {
    const to = String(o.to || '').trim(); if (!EMAIL.test(to)) throw new Error('mail needs a valid "to" address');
    if (!o.subject || !o.body) throw new Error('mail needs a subject and a body');
    if (o.dedupe) { const dup = Q().find((m) => m.dedupe === o.dedupe); if (dup) return dup; }
    const m = { id: uid('mail'), venture_id: o.venture_id || null, to, subject: String(o.subject).slice(0, 200), body: String(o.body).slice(0, 10000), kind: o.kind || 'sequence', sequence: o.sequence || null, step: o.step || null,
      enrollment_id: o.enrollment_id || null, ref: o.ref || null, priority: o.priority || 'normal', flags: o.flags || [], status: 'draft', created: ctx.now(), attempts: 0, dedupe: o.dedupe || null, agent_id: o.agent_id || null };
    if (o.status === 'approved' || autoSend(m)) { m.status = 'approved'; m.approved_at = ctx.now(); m.approved_by = o.status === 'approved' ? 'pre-approved' : 'auto_send setting'; }
    Q().push(m); if (Q().length > 5000) Q().splice(0, Q().length - 5000); ctx.db.save('mail'); ctx.emit('mail.queued', { mail_id: m.id, kind: m.kind, sequence: m.sequence, priority: m.priority }, m.venture_id); return m;
  }
  const get = (id) => Q().find((m) => m.id === id) || null;
  const list = (f = {}) => Q().filter((m) => (!f.status || m.status === f.status) && (!f.venture_id || m.venture_id === f.venture_id) && (!f.kind || m.kind === f.kind));
  function approve(id, by = 'owner') { const m = get(id); if (!m || m.status !== 'draft') return null; m.status = 'approved'; m.approved_at = ctx.now(); m.approved_by = by; ctx.db.save('mail'); return m; }
  function reject(id, note = '') { const m = get(id); if (!m || !['draft', 'approved'].includes(m.status)) return null; m.status = 'rejected'; m.note = note; ctx.db.save('mail'); return m; }
  function edit(id, { subject, body }) { const m = get(id); if (!m || m.status !== 'draft') return null; if (subject) m.subject = String(subject).slice(0, 200); if (body) m.body = String(body).slice(0, 10000); m.flags = m.flags.filter((f) => f !== 'placeholder'); ctx.db.save('mail'); return m; }
  function markSent(id) { const m = get(id); if (!m || !['manual', 'approved'].includes(m.status)) return null; m.status = 'sent'; m.sent_at = ctx.now(); m.via = 'manual'; ctx.db.save('mail'); ctx.emit('mail.sent', { mail_id: m.id, kind: m.kind, ref: m.ref }, m.venture_id); return m; }

  // ---- sending
  const startOfDay = () => { const d = new Date(ctx.now()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const sentToday = () => Q().filter((m) => m.status === 'sent' && m.via !== 'manual' && m.sent_at >= startOfDay()).length;
  const inWindow = () => { const h = new Date(ctx.now()).getHours(); const w = ctx.settings().mail.window || {}; return h >= (w.start ?? 0) && h < (w.end ?? 24); };
  /** Compose the final text: body + opt-out footer + one-click unsubscribe. Marketing mail without a footer is refused, not sent. */
  function render(m) {
    const c = cfg(); const marketing = !TRANSACTIONAL.has(m.kind) && m.kind !== 'billing_notice';
    const unsub = m.kind === 'owner_digest' ? null : unsubLink(m.venture_id, m.to);
    if (marketing && !c.footer) throw new Error('set an opt-out footer with a postal address (secret mail_footer) before sending marketing or lifecycle e-mail');
    const foot = [c.footer, unsub ? `Unsubscribe: ${unsub}` : ''].filter(Boolean).join('\n');
    return { text: foot ? `${m.body}\n\n--\n${foot}` : m.body, unsub };
  }
  /** Send what is approved. Returns counts; never throws (a bad message fails alone). */
  async function flush({ max = 20 } = {}) {
    const out = { sent: 0, manual: 0, failed: 0, held: 0 };
    if (ctx.settings().mail.hold) { out.held = list({ status: 'approved' }).length; out.on_hold = true; return out; } // the remote STOP: nothing leaves until a human resumes
    const prov = provider(); const c = cfg(); const limit = ctx.settings().mail.daily_limit;
    const ready = list({ status: 'approved' }).sort((a, b) => (b.priority === 'fast') - (a.priority === 'fast') || a.created - b.created);
    for (const m of ready) {
      if (out.sent + out.manual >= max) break;
      if (isUnsubscribed(m.to) && !TRANSACTIONAL.has(m.kind)) { m.status = 'skipped'; m.error = 'recipient opted out'; continue; }
      if (m.venture_id && !ctx.ventures.canWork(m.venture_id) && !TRANSACTIONAL.has(m.kind)) { m.status = 'skipped'; m.error = 'venture is not active'; continue; }
      if (prov === 'manual') { m.status = 'manual'; out.manual++; continue; }
      if (sentToday() >= limit) { out.held++; break; }
      if (m.priority !== 'fast' && !TRANSACTIONAL.has(m.kind) && !inWindow()) { out.held++; continue; }
      try {
        const r = render(m); m.attempts++;
        const res = await rails[prov]({ to: m.to, subject: m.subject, text: r.text, unsub: r.unsub, venture_id: m.venture_id }, c);
        m.status = 'sent'; m.sent_at = ctx.now(); m.via = prov; m.provider_id = res && res.id || null; out.sent++;
        ctx.emit('mail.sent', { mail_id: m.id, kind: m.kind, sequence: m.sequence, ref: m.ref }, m.venture_id);
      } catch (e) { m.error = e.message; if (m.attempts >= 3 || /footer/.test(e.message)) m.status = 'failed'; out.failed++; ctx.emit('mail.failed', { mail_id: m.id, error: e.message }, m.venture_id); }
    }
    ctx.db.save('mail'); return out;
  }
  /** A note to the owner (digest, fast-lane alert). Goes straight out: it is addressed to the owner, not to a prospect. */
  function notifyOwner(subject, body, venture_id = null, dedupe = null) {
    const to = cfg().owner; if (!EMAIL.test(to || '')) return null;
    return queue({ venture_id, to, subject, body, kind: 'owner_digest', status: 'approved', priority: 'fast', dedupe });
  }
  const status = () => { const c = cfg(); return { provider: provider(), configured: configured(), from_set: !!c.from, footer_set: !!c.footer, owner_set: EMAIL.test(c.owner || ''), sent_today: sentToday(), daily_limit: ctx.settings().mail.daily_limit,
    drafts: list({ status: 'draft' }).length, approved: list({ status: 'approved' }).length, manual: list({ status: 'manual' }).length, failed: list({ status: 'failed' }).length, unsubscribed: Object.keys(U()).length }; };

  return { queue, get, list, approve, reject, edit, markSent, flush, notifyOwner, status, unsubscribe, isUnsubscribed, unsubLink, verifyUnsub, registerMailer, provider, configured, render, rails, TRANSACTIONAL, EMAIL };
}
module.exports = { makeMail, TRANSACTIONAL, EMAIL, DAY };
