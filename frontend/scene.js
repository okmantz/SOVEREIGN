// The station renderer: a dark deck with neon-green trim, rooms with back walls and 3D desks, animated matrix rain.
// Static geometry is cached in an offscreen layer; agents, holo screens, pulses and highlights draw live on top.
(function () {
  'use strict';
  const T = 30, OY = 46, CW = 1440, CH = 1024, GW = 48, GH = 32, WH = 38;
  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let canvas, ctx, layer, lc, dirty = true, cols = [], lastT = 0;
  const cam = { z: 1, x: 0, y: 0 }; // world -> canvas: screen = world * z + offset

  const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const hashOf = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const kindColor = (S, k) => (S.roomKinds[k] || S.roomKinds.custom).color;

  function init(c) {
    canvas = c; canvas.width = CW; canvas.height = CH; ctx = canvas.getContext('2d');
    layer = document.createElement('canvas'); layer.width = CW * 2; layer.height = CH * 2; lc = layer.getContext('2d'); // 2x so zooming stays sharp
    for (let x = 0; x < CW; x += 22) cols.push({ x, y: Math.random() * CH, v: 0.6 + Math.random() * 1.6, len: 8 + Math.floor(Math.random() * 14), seed: Math.random() });
  }
  const invalidate = () => { dirty = true; };

  // ---------- geometry (world px; y already includes OY) ----------
  function nodeRect(S, ref) {
    let r;
    if (ref === 'inbox' || ref === 'outbox') r = S.fixed[ref];
    else { const [t, id] = ref.split(':'); if (t === 'room') r = S.rooms[id]; else { const c = S.connectors[id]; r = c && { x: c.x, y: c.y, w: 2, h: 2 }; } }
    return r || null;
  }
  const center = (r) => ({ x: (r.x + r.w / 2) * T, y: (r.y + r.h / 2) * T + OY });
  function hallPath(S, hw) {
    const a = nodeRect(S, hw.from), b = nodeRect(S, hw.to); if (!a || !b) return null;
    const ca = center(a), cb = center(b), vert = Math.abs(cb.y - ca.y) > Math.abs(cb.x - ca.x);
    return [ca, vert ? { x: ca.x, y: cb.y } : { x: cb.x, y: ca.y }, cb];
  }
  // client pixels -> internal canvas pixels (the canvas is letterboxed inside its box)
  function toCanvas(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), s = Math.min(r.width / CW, r.height / CH);
    return { cx: (clientX - r.left - (r.width - CW * s) / 2) / s, cy: (clientY - r.top - (r.height - CH * s) / 2) / s, s };
  }
  function toWorld(clientX, clientY) {
    const { cx, cy } = toCanvas(clientX, clientY);
    const wx = (cx - cam.x) / cam.z, wy = (cy - cam.y) / cam.z - OY;
    return { px: wx, py: wy, tx: Math.floor(wx / T), ty: Math.floor(wy / T) };
  }
  function zoomAt(clientX, clientY, f) {
    const { cx, cy } = toCanvas(clientX, clientY), nz = Math.max(0.7, Math.min(3.2, cam.z * f)), wx = (cx - cam.x) / cam.z, wy = (cy - cam.y) / cam.z;
    cam.z = nz; cam.x = cx - wx * nz; cam.y = cy - wy * nz;
  }
  function panBy(dx, dy) { const r = canvas.getBoundingClientRect(), s = Math.min(r.width / CW, r.height / CH); cam.x += dx / s; cam.y += dy / s; }
  const fit = () => { cam.z = 1; cam.x = 0; cam.y = 0; };
  const inR = (x, y, r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  function distSeg(px, py, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1; let t = ((px - a.x) * dx + (py - a.y) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)); }
  const agentAt = (S, deskId) => Object.values(S.agents).find((a) => a.deskId === deskId);

  // px,py are world pixels with OY removed.
  function hit(S, px, py) {
    const tx = px / T, ty = py / T;
    for (const d of Object.values(S.desks)) { const a = agentAt(S, d.id); if (a && px >= d.x * T + T - 27 && px < d.x * T + T + 27 && py >= d.y * T - 46 && py < d.y * T + 4) return { type: 'agent', id: a.id }; }
    for (const d of Object.values(S.desks)) if (inR(tx, ty, { x: d.x, y: d.y, w: 2, h: 1 })) return { type: 'desk', id: d.id };
    for (const c of Object.values(S.connectors)) if (inR(tx, ty, { x: c.x, y: c.y - 0.6, w: 2, h: 2.6 })) return { type: 'connector', id: c.id };
    for (const r of Object.values(S.rooms)) if (inR(tx, ty, r) || (px >= r.x * T - 8 && px < (r.x + r.w) * T + 8 && py >= r.y * T - WH - 7 && py < r.y * T)) return { type: 'room', id: r.id };
    for (const k of ['inbox', 'outbox']) if (inR(tx, ty, S.fixed[k])) return { type: 'dock', id: k };
    for (const hw of Object.values(S.hallways)) { const p = hallPath(S, hw); if (!p) continue; const q = p.map((v) => ({ x: v.x, y: v.y - OY })); if (distSeg(px, py, q[0], q[1]) < 10 || distSeg(px, py, q[1], q[2]) < 10) return { type: 'hallway', id: hw.id }; }
    return null;
  }

  // ---------- static layer ----------
  function glowLine(c, x1, y1, x2, y2, col, w, blur) { c.save(); c.shadowColor = col; c.shadowBlur = blur; c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.restore(); }
  function neonText(c, text, x, y, col, size, align) {
    c.save(); c.font = `700 ${size}px ${FONT}`; c.textAlign = align || 'center'; c.textBaseline = 'middle'; c.shadowColor = col; c.shadowBlur = 10; c.fillStyle = col; c.fillText(text, x, y); c.restore();
  }

  function drawDeck(c) {
    const x = 0, y = OY, w = GW * T, h = GH * T;
    c.fillStyle = 'rgba(1,10,5,.88)'; c.fillRect(x, y, w, h);
    c.lineWidth = 1;
    for (let i = 0; i <= GW; i++) { c.strokeStyle = i % 4 ? 'rgba(0,255,120,.045)' : 'rgba(0,255,120,.11)'; c.beginPath(); c.moveTo(i * T + .5, y); c.lineTo(i * T + .5, y + h); c.stroke(); }
    for (let j = 0; j <= GH; j++) { c.strokeStyle = j % 4 ? 'rgba(0,255,120,.045)' : 'rgba(0,255,120,.11)'; c.beginPath(); c.moveTo(0, y + j * T + .5); c.lineTo(w, y + j * T + .5); c.stroke(); }
    c.save(); c.shadowColor = '#00ff88'; c.shadowBlur = 14; c.strokeStyle = 'rgba(0,255,136,.5)'; c.lineWidth = 2; c.strokeRect(1, y + 1, w - 2, h - 2); c.restore();
  }

  function drawHallway(c, S, hw) {
    const p = hallPath(S, hw); if (!p) return;
    const trace = () => { c.beginPath(); c.moveTo(p[0].x, p[0].y); c.lineTo(p[1].x, p[1].y); c.lineTo(p[2].x, p[2].y); };
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = '#020c07'; c.lineWidth = 20; trace(); c.stroke();
    c.strokeStyle = '#08301a'; c.lineWidth = 14; trace(); c.stroke();
    c.save(); c.shadowColor = '#00ff66'; c.shadowBlur = 10; c.strokeStyle = 'rgba(0,255,102,.6)'; c.lineWidth = 2.5; trace(); c.stroke(); c.restore();
    // direction chevrons
    c.fillStyle = 'rgba(120,255,180,.55)';
    for (let s = 0; s < 2; s++) {
      const a = p[s], b = p[s + 1], len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 30) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      for (let d = 45; d < len - 25; d += 46) { const x = a.x + ux * d, y = a.y + uy * d; c.beginPath(); c.moveTo(x + ux * 5, y + uy * 5); c.lineTo(x - ux * 4 - uy * 4, y - uy * 4 + ux * 4); c.lineTo(x - ux * 4 + uy * 4, y - uy * 4 - ux * 4); c.closePath(); c.fill(); }
    }
  }

  function drawDock(c, S, k) {
    const r = S.fixed[k], X = r.x * T, Y = r.y * T + OY, W = r.w * T, H = r.h * T, col = k === 'inbox' ? '#00ff88' : '#ffd24a';
    c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(X + 6, Y + 6, W, H);
    c.fillStyle = '#06150d'; c.fillRect(X, Y, W, H);
    c.save(); c.shadowColor = col; c.shadowBlur = 10; c.strokeStyle = rgba(col, .8); c.lineWidth = 2; c.strokeRect(X + 1, Y + 1, W - 2, H - 2); c.restore();
    const bx = X + 18, bw = W - 36, by = Y + 30; // crate
    c.fillStyle = shadeCol(col, .5); c.fillRect(bx, by, bw, 14);                       // top face
    c.fillStyle = shadeCol(col, .3); c.fillRect(bx, by + 14, bw, H - 52);              // front face
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(bx, by + 14, bw, 2);
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.strokeRect(bx + .5, by + .5, bw - 1, H - 39);
    neonText(c, k === 'inbox' ? 'Inbox' : 'Outbox', X + W / 2, Y - 12, col, 15);
  }
  function shadeCol(h, a) { const n = parseInt(h.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return `rgb(${Math.round(r * a)},${Math.round(g * a)},${Math.round(b * a)})`; }

  function drawRoom(c, S, r) {
    const X = r.x * T, Y = r.y * T + OY, W = r.w * T, H = r.h * T, col = kindColor(S, r.kind), rnd = hashOf(r.id);
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(X + 4, Y - WH + 12, W + 14, H + WH + 6);
    let g = c.createLinearGradient(0, Y, 0, Y + H); g.addColorStop(0, '#07160e'); g.addColorStop(1, '#0d2b1b'); c.fillStyle = g; c.fillRect(X, Y, W, H);
    g = c.createLinearGradient(0, Y, 0, Y + H * .7); g.addColorStop(0, rgba(col, .16)); g.addColorStop(1, rgba(col, 0)); c.fillStyle = g; c.fillRect(X, Y, W, H);
    c.lineWidth = 1; c.strokeStyle = rgba(col, .08);
    for (let i = 1; i < r.w; i++) { c.beginPath(); c.moveTo(X + i * T + .5, Y); c.lineTo(X + i * T + .5, Y + H); c.stroke(); }
    for (let j = 1; j < r.h; j++) { c.beginPath(); c.moveTo(X, Y + j * T + .5); c.lineTo(X + W, Y + j * T + .5); c.stroke(); }
    c.setLineDash([5, 6]); c.strokeStyle = rgba(col, .25); c.strokeRect(X + 9.5, Y + 12.5, W - 19, H - 22); c.setLineDash([]);
    // back wall
    g = c.createLinearGradient(0, Y - WH, 0, Y); g.addColorStop(0, '#15402a'); g.addColorStop(1, '#071a10'); c.fillStyle = g; c.fillRect(X - 8, Y - WH, W + 16, WH);
    c.fillStyle = '#2b6c49'; c.fillRect(X - 8, Y - WH - 7, W + 16, 7);
    c.save(); c.shadowColor = col; c.shadowBlur = 8; c.fillStyle = col; c.fillRect(X - 8, Y - WH - 7, W + 16, 2); c.restore();
    const pw = 44, n = Math.max(1, Math.floor((W - 4) / (pw + 6)));
    const sx = X + (W - (n * pw + (n - 1) * 6)) / 2;
    for (let i = 0; i < n; i++) {
      const px = sx + i * (pw + 6);
      c.fillStyle = '#031009'; c.fillRect(px, Y - WH + 7, pw, WH - 15);
      c.strokeStyle = rgba(col, .4); c.strokeRect(px + .5, Y - WH + 7.5, pw - 1, WH - 16);
      for (let l = 0; l < 3; l++) { const len = 10 + ((rnd >> (l * 3 + i)) % 26); c.fillStyle = rgba(col, .5); c.fillRect(px + 5, Y - WH + 12 + l * 6, len, 2); }
    }
    // neon name sign
    const fs = Math.max(9, Math.min(15, (W - 30) / (Math.max(4, r.name.length) * .62)));
    c.font = `700 ${fs}px ${FONT}`; const tw = c.measureText(r.name).width + 20;
    c.fillStyle = 'rgba(2,14,8,.92)'; c.fillRect(X + W / 2 - tw / 2, Y - WH / 2 - 9, tw, 20); c.strokeStyle = rgba(col, .9); c.strokeRect(X + W / 2 - tw / 2 + .5, Y - WH / 2 - 8.5, tw - 1, 19);
    neonText(c, r.name, X + W / 2, Y - WH / 2 + 1, col, fs);
    // side walls with caps, front lip, posts
    for (const sxw of [X - 8, X + W]) {
      const sg = c.createLinearGradient(sxw, 0, sxw + 8, 0); sg.addColorStop(0, '#0e2d1e'); sg.addColorStop(1, '#061510'); c.fillStyle = sg; c.fillRect(sxw, Y - WH, 8, H + WH + 8);
      c.fillStyle = '#2b6c49'; c.fillRect(sxw, Y - WH - 7, 8, 7); c.save(); c.shadowColor = col; c.shadowBlur = 8; c.fillStyle = col; c.fillRect(sxw + 3, Y - WH, 2, H + WH + 8); c.restore();
    }
    c.fillStyle = '#0a2216'; c.fillRect(X - 8, Y + H, W + 16, 8);
    glowLine(c, X - 8, Y + H + 8, X + W + 8, Y + H + 8, rgba(col, .9), 2, 10);
  }

  function drawConnector(c, S, k) {
    const meta = S.connectorKinds[k.kind] || {}, col = meta.color || '#8fbf9f', cx = (k.x + 1) * T, cy = (k.y + 1) * T + OY;
    c.fillStyle = 'rgba(0,0,0,.55)'; c.beginPath(); c.ellipse(cx + 4, cy + 20, 26, 9, 0, 0, 7); c.fill();
    c.fillStyle = '#04120a'; c.beginPath(); c.ellipse(cx, cy + 16, 27, 10, 0, 0, 7); c.fill();
    c.save(); c.shadowColor = col; c.shadowBlur = 10; c.strokeStyle = rgba(col, .85); c.lineWidth = 2; c.beginPath(); c.ellipse(cx, cy + 16, 27, 10, 0, 0, 7); c.stroke(); c.restore();
    const g = c.createLinearGradient(cx - 20, 0, cx + 20, 0); g.addColorStop(0, shadeCol(col, .25)); g.addColorStop(.5, shadeCol(col, .55)); g.addColorStop(1, shadeCol(col, .2));
    c.fillStyle = g; c.fillRect(cx - 20, cy - 8, 40, 24); c.beginPath(); c.ellipse(cx, cy + 16, 20, 7, 0, 0, Math.PI); c.fill();
    c.fillStyle = shadeCol(col, .8); c.beginPath(); c.ellipse(cx, cy - 8, 20, 8, 0, 0, 7); c.fill();
    c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.ellipse(cx, cy - 8, 20, 8, 0, 0, 7); c.stroke();
    c.save(); c.font = `700 11px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#020a05'; c.fillText(meta.glyph || '?', cx, cy - 8); c.restore();
    neonText(c, k.name, cx, cy + 36, col, 11);
    const st = k.status === 'ready' ? '#00ff88' : k.status === 'error' ? '#ff5a5f' : k.status === 'untested' ? '#ffc542' : '#5a7a68';
    if (meta.live) { c.save(); c.shadowColor = st; c.shadowBlur = 8; c.fillStyle = st; c.beginPath(); c.arc(cx + 24, cy - 16, 4, 0, 7); c.fill(); c.restore(); }
  }

  function buildStatic(S) {
    lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, layer.width, layer.height); lc.setTransform(2, 0, 0, 2, 0, 0); drawDeck(lc);
    for (const hw of Object.values(S.hallways)) drawHallway(lc, S, hw);
    for (const k of ['inbox', 'outbox']) drawDock(lc, S, k);
    for (const r of Object.values(S.rooms).sort((a, b) => a.y - b.y)) drawRoom(lc, S, r);
    for (const k of Object.values(S.connectors).sort((a, b) => a.y - b.y)) drawConnector(lc, S, k);
    dirty = false;
  }

  // ---------- dynamic ----------
  function drawRain(dt, now) {
    ctx.fillStyle = '#010503'; ctx.fillRect(0, 0, CW, CH);
    ctx.font = `15px ${FONT}`; ctx.textAlign = 'center';
    for (const col of cols) {
      if (!reduce) col.y += col.v * dt * 0.06;
      if (col.y - col.len * 17 > CH) { col.y = -Math.random() * 200; col.v = 0.6 + Math.random() * 1.6; }
      for (let i = 0; i < col.len; i++) {
        const y = col.y - i * 17; if (y < -10 || y > CH + 10) continue;
        const ch = GLYPHS[(Math.floor(col.seed * 1000) + i * 7 + Math.floor(now / 260) * (i % 3 === 0 ? 1 : 0)) % GLYPHS.length];
        ctx.fillStyle = i === 0 ? 'rgba(210,255,225,.55)' : `rgba(0,255,110,${Math.max(0, 0.26 - i * 0.017)})`;
        ctx.fillText(ch, col.x, y);
      }
    }
  }

  function drawAgentDesk(S, d, ui, now) {
    const a = agentAt(S, d.id), room = S.rooms[d.roomId], col = room ? kindColor(S, room.kind) : '#00ff88';
    const X = d.x * T, Y = d.y * T + OY, cx = X + T, busy = a && ui.busy.has(a.id);
    const chosen = a && ui.chatAgent === a.id, sel = ui.sel && ((ui.sel.type === 'agent' && a && ui.sel.id === a.id) || (ui.sel.type === 'desk' && ui.sel.id === d.id));
    if (busy) { ctx.save(); const pulse = 0.25 + 0.15 * Math.sin(now / 220); ctx.fillStyle = `rgba(0,255,136,${pulse})`; ctx.beginPath(); ctx.ellipse(cx, Y + 30, 48, 14, 0, 0, 7); ctx.fill(); ctx.restore(); }
    if (a) {
      ctx.fillStyle = '#0a1c13'; ctx.fillRect(cx - 16, Y - 32, 32, 28); ctx.strokeStyle = 'rgba(0,255,136,.25)'; ctx.strokeRect(cx - 15.5, Y - 31.5, 31, 27); // chair back
      const bob = busy ? (Math.floor(now / 320) % 2) : 0;
      window.Avatar.draw(ctx, a.avatar, cx - 27, Y - 46 + bob, 3, window.Avatar.frameFor(a.id, now, busy));
    }
    // desk: top surface, front face, glowing edge
    ctx.fillStyle = '#185236'; ctx.fillRect(X, Y + 4, 2 * T, 10); ctx.fillStyle = '#2a7a52'; ctx.fillRect(X, Y + 4, 2 * T, 2);
    const fg = ctx.createLinearGradient(0, Y + 14, 0, Y + 36); fg.addColorStop(0, '#0e3322'); fg.addColorStop(1, '#06170f'); ctx.fillStyle = fg; ctx.fillRect(X, Y + 14, 2 * T, 22);
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = sel ? 14 : 6; ctx.fillStyle = sel ? '#ffffff' : rgba(col, .85); ctx.fillRect(X, Y + 34, 2 * T, 2); ctx.restore();
    ctx.fillStyle = '#04120a'; ctx.fillRect(cx - 11, Y + 6, 22, 6); ctx.fillStyle = 'rgba(0,255,136,.45)'; for (let i = 0; i < 6; i++) ctx.fillRect(cx - 9 + i * 3.6, Y + 8, 2, 2);
    if (a) {
      ctx.save(); ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = sel || chosen ? '#ffffff' : '#9bf5c4'; ctx.shadowColor = '#00ff88'; ctx.shadowBlur = chosen ? 8 : 0; ctx.fillText(a.name.slice(0, 12), cx, Y + 25); ctx.restore();
      // holographic screen beside the desk
      const hx = X + 2 * T - 4, hy = Y - 44;
      ctx.save(); ctx.globalAlpha = busy ? 0.95 : 0.4; ctx.fillStyle = 'rgba(0,40,20,.75)'; ctx.fillRect(hx, hy, 34, 24); ctx.strokeStyle = '#00ff88'; ctx.strokeRect(hx + .5, hy + .5, 33, 23);
      ctx.fillStyle = '#00ff88'; for (let l = 0; l < 4; l++) { const w = busy ? 6 + ((Math.floor(now / 180) * 7 + l * 11) % 20) : 8 + l * 4; ctx.fillRect(hx + 4, hy + 4 + l * 5, Math.min(w, 26), 2); }
      ctx.restore();
      if (busy) { ctx.fillStyle = '#eafff2'; ctx.fillRect(cx + 16, Y - 62, 26, 14); ctx.fillStyle = '#031009'; ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('.'.repeat(1 + (Math.floor(now / 300) % 3)), cx + 29, Y - 54); }
      if (chosen) { const b = Math.sin(now / 240) * 2; ctx.fillStyle = '#00ff88'; ctx.beginPath(); ctx.moveTo(cx - 6, Y - 58 + b); ctx.lineTo(cx + 6, Y - 58 + b); ctx.lineTo(cx, Y - 50 + b); ctx.fill(); }
    } else {
      ctx.save(); ctx.font = `10px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(120,200,160,.55)'; ctx.fillText('empty desk', cx, Y + 26); ctx.restore();
    }
    if (sel) { ctx.save(); ctx.shadowColor = '#7dffc0'; ctx.shadowBlur = 12; ctx.strokeStyle = '#eafff2'; ctx.lineWidth = 2; ctx.strokeRect(X - 3, Y - (a ? 50 : 0), 2 * T + 6, a ? 90 : 40); ctx.restore(); }
  }

  function highlightRect(x, y, w, h, col) { ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.strokeRect(x, y, w, h); ctx.restore(); }

  function render(now, S, ui) {
    const dt = Math.min(64, now - lastT || 16); lastT = now;
    drawRain(dt, now);
    if (!S) return;
    if (dirty) buildStatic(S);
    ctx.save(); ctx.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
    ctx.drawImage(layer, 0, 0, CW, CH);
    for (const d of Object.values(S.desks).sort((a, b) => a.y - b.y)) drawAgentDesk(S, d, ui, now);
    // outbox badge
    if (S.outbox.length) { const r = S.fixed.outbox; ctx.save(); ctx.font = `700 13px ${FONT}`; ctx.fillStyle = '#ffd24a'; ctx.textAlign = 'right'; ctx.shadowColor = '#ffd24a'; ctx.shadowBlur = 8; ctx.fillText(String(S.outbox.length), (r.x + r.w) * T - 8, r.y * T + OY + 20); ctx.restore(); }
    // handoff pulses
    for (let i = ui.pulses.length - 1; i >= 0; i--) {
      const pu = ui.pulses[i], t = (now - pu.t0) / pu.dur; if (t >= 1) { ui.pulses.splice(i, 1); continue; }
      const segs = [[pu.p[0], pu.p[1]], [pu.p[1], pu.p[2]]], lens = segs.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y)), total = lens[0] + lens[1] || 1;
      let d = t * total, k = 0; if (d > lens[0]) { d -= lens[0]; k = 1; }
      const [a, b] = segs[k], f = lens[k] ? d / lens[k] : 0, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      ctx.save(); ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 20; ctx.fillStyle = '#b6ffd6'; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill(); ctx.restore();
    }
    // selection + tool ghosts
    const sel = ui.sel;
    if (sel && sel.type === 'room' && S.rooms[sel.id]) { const r = S.rooms[sel.id]; highlightRect(r.x * T - 9, r.y * T + OY - WH - 8, r.w * T + 18, r.h * T + WH + 17, '#eafff2'); }
    if (sel && sel.type === 'connector' && S.connectors[sel.id]) { const k = S.connectors[sel.id]; highlightRect(k.x * T - 6, k.y * T + OY - 20, 2 * T + 12, 2 * T + 22, '#eafff2'); }
    if (sel && sel.type === 'hallway' && S.hallways[sel.id]) { const p = hallPath(S, S.hallways[sel.id]); if (p) { ctx.save(); ctx.shadowColor = '#eafff2'; ctx.shadowBlur = 14; ctx.strokeStyle = '#eafff2'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[1].x, p[1].y); ctx.lineTo(p[2].x, p[2].y); ctx.stroke(); ctx.restore(); } }
    if (ui.drag && ui.drag.kind === 'room') {
      const r = ui.dragRect(ui.drag); ctx.save(); ctx.setLineDash([7, 5]); ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 12; ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(0,255,136,.08)';
      ctx.fillRect(r.x * T, r.y * T + OY, r.w * T, r.h * T); ctx.strokeRect(r.x * T, r.y * T + OY, r.w * T, r.h * T); ctx.restore(); neonText(ctx, `${r.w} × ${r.h}`, r.x * T + 6, r.y * T + OY + 12, '#00ff88', 12, 'left');
    }
    if (ui.tool === 'hallway') {
      if (ui.linkFrom) { const a = nodeRect(S, ui.linkFrom); if (a) { const c = center(a); ctx.save(); ctx.setLineDash([7, 6]); ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 10; ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(ui.mouse.px, ui.mouse.py + OY); ctx.stroke(); ctx.restore(); } }
      const h = ui.hover && (ui.hover.type === 'room' ? 'room:' + ui.hover.id : ui.hover.type === 'connector' ? 'connector:' + ui.hover.id : ui.hover.type === 'dock' ? ui.hover.id : null);
      const nr = h && nodeRect(S, h); if (nr) highlightRect(nr.x * T - 3, nr.y * T + OY - 3, nr.w * T + 6, nr.h * T + 6, '#ffffff');
    }
    if (ui.tool === 'desk' && ui.hover && ui.hover.type === 'room') { const tx = Math.floor(ui.mouse.px / T), ty = Math.floor(ui.mouse.py / T); highlightRect(tx * T, ty * T + OY, 2 * T, T, '#00ff88'); }
    ctx.restore();
  }

  window.Scene = { T, OY, CW, CH, init, invalidate, render, toWorld, zoomAt, panBy, fit, zoom: () => cam.z, hit, nodeRect, hallPath, center };
})();
