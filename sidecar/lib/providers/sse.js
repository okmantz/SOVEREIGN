'use strict';
// One streaming chat call to any OpenAI-style endpoint. Streaming means text appears as it is written instead of after
// the whole answer is done, and a burst of parallel agents gets retries with backoff instead of failing on a rate limit.
// Servers that reject streaming options fall back step by step to a plain request, so nothing that worked before breaks.
const FIRST_MS = 90000; // wait this long for the first bytes
const IDLE_MS = 45000;  // then this long of silence means it is stuck
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, http, retry) => { const e = new Error(msg); e.status = 502; e.http = http || 0; e.retry = !!retry; return e; };
const errText = (j, code) => (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || code;

async function once({ url, headers, body, label, onToken }) {
  const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), FIRST_MS);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), IDLE_MS); };
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal }); }
  catch (e) { clearTimeout(timer); throw e.name === 'AbortError' ? fail(`${label} took too long to respond.`) : fail(`Could not reach ${label}.`, 0, true); }
  try {
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw fail(`${label}: ${errText(j, res.status)}`, res.status, res.status === 429 || res.status >= 500); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream') || !res.body || !res.body.getReader) {
      const j = await res.json().catch(() => ({})), text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      if (text && onToken) onToken(text);
      return { text, usage: j.usage || {} };
    }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', text = '', usage = {};
    for (;;) {
      const { done, value } = await reader.read(); if (done) break; bump(); buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (_) { continue; }
        if (j.error) throw fail(`${label}: ${errText(j, 'stream error')}`);
        const c = j.choices && j.choices[0], piece = c && ((c.delta && c.delta.content) || (c.message && c.message.content));
        if (piece) { text += piece; if (onToken) onToken(text); }
        if (j.usage) usage = j.usage;
      }
    }
    return { text, usage };
  } catch (e) { if (e.status) throw e; throw fail(e.name === 'AbortError' ? `${label} stopped responding mid-answer.` : `Lost the connection to ${label}.`, 0, true); }
  finally { clearTimeout(timer); }
}

// plans: request bodies to try in order (streaming with usage, streaming plain, non-streaming).
async function chat({ url, headers, plans, label, onToken }) {
  let vi = 0, lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await once({ url, headers, body: plans[vi], label, onToken }); }
    catch (e) {
      lastErr = e;
      if (e.http === 400 && vi < plans.length - 1) { vi++; attempt--; continue; } // the server did not like streaming options
      if (!e.retry || attempt === 3) throw e;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    }
  }
  throw lastErr;
}
module.exports = { chat };
