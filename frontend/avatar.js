// Procedural pixel characters. 16x24 grid (+1px padding for the outline), built from layered parts:
// outfit, head, hair, facial hair, eyewear, headwear, accessory. No image assets.
(function () {
  'use strict';
  const W = 18, H = 26, OUTLINE = '#02100a';
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const shade = (h, a) => { const [r, g, b] = rgb(h), t = a < 0 ? 0 : 255, p = Math.abs(a); return hex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p); };
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t); };

  function build(av, frame) {
    const buf = new Array(W * H).fill(null);
    const p = (x, y, c) => { x += 1; y += 1; if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = c; };
    const r = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p(x + i, y + j, c); };
    const get = (x, y) => buf[(y + 1) * W + (x + 1)];
    const skin = av.skin, skinD = shade(skin, -0.22), skinL = shade(skin, 0.12);
    const hair = av.hairColor, hairD = shade(hair, -0.3), hairL = shade(hair, 0.25);
    const oc = av.outfitColor, ocD = shade(oc, -0.3), ocL = shade(oc, 0.2);
    const ac = av.accent, acD = shade(ac, -0.4);
    const hat = av.hatColor, hatD = shade(hat, -0.3), hatL = shade(hat, 0.22);
    const white = '#f2f6f4', metal = '#a9b5c2', metalD = '#6f7c8a', metalL = '#d6dee6', dark = '#0b0f14', gold = '#e6b73a';
    const typing = frame === 1, blink = frame === 2, o = av.outfit, robot = av.head === 'robot', hw = av.headwear;

    // ---- back layers (behind the body)
    if (hw === 'hood') r(3, 1, 10, 11, shade(hat, -0.35));
    if (av.hair === 'long' && hw !== 'helmet') r(3, 3, 10, 10, hairD);

    // ---- legs and shoes
    const legC = { tee: '#22305a', jacket: '#22305a', hoodie: '#1d2745', vest: '#1d2745', labcoat: '#3a4152', tactical: '#20262d', trench: '#141a22' }[o] || oc;
    r(4, 18, 4, 4, legC); r(8, 18, 4, 4, legC); r(7, 18, 1, 4, shade(legC, -0.35)); r(8, 18, 1, 4, shade(legC, -0.2));
    const boot = o === 'spacesuit' || o === 'armor' ? metalD : dark;
    r(4, 22, 4, 2, boot); r(8, 22, 4, 2, boot); p(5, 22, shade(boot, 0.3)); p(9, 22, shade(boot, 0.3));

    // ---- outfit (torso + arms)
    const arms = (sleeve, sc, cuff, hand) => {
      const ay = typing ? -1 : 0;
      for (const x of [1, 13]) {
        r(x, 11, 2, sleeve, sc); r(x, 11 + sleeve, 2, Math.max(0, 7 - sleeve + ay), hand);
        if (cuff) r(x, 10 + sleeve, 2, 1, cuff);
      }
      r(14, 11, 1, sleeve, shade(sc, -0.25)); r(2, 11, 1, sleeve, shade(sc, 0.08));
    };
    const torso = (x, y, w, h, c) => { r(x, y, w, h, c); r(x + w - 1, y, 1, h, shade(c, -0.28)); r(x, y, w, 1, shade(c, 0.18)); };
    r(6, 10, 4, 2, skinD); // neck
    if (o === 'tee') { arms(4, oc, null, skin); torso(3, 11, 10, 8, oc); r(6, 11, 4, 1, skinD); }
    else if (o === 'suit') { arms(7, oc, null, skin); torso(3, 11, 10, 8, oc); r(7, 11, 2, 6, white); r(7, 12, 2, 5, ac); p(7, 11, white); p(8, 11, white);
      for (let y = 11; y < 15; y++) { p(6, y, ocL); p(9, y, ocL); } p(4, 14, white); p(8, 18, ocL); r(1, 17, 2, 1, skin); r(13, 17, 2, 1, skin); }
    else if (o === 'labcoat') { arms(6, oc, shade(oc, -0.15), skin); torso(2, 11, 12, 11, oc); r(6, 11, 4, 8, ac); r(7, 11, 2, 11, shade(oc, -0.12));
      r(3, 17, 3, 2, ocD); r(10, 17, 3, 2, ocD); p(5, 11, ocL); p(10, 11, ocL); }
    else if (o === 'hoodie') { r(3, 10, 10, 2, ocD); arms(7, oc, ocD, skin); torso(3, 11, 10, 8, oc); r(5, 16, 6, 3, ocD); r(6, 12, 1, 3, white); r(9, 12, 1, 3, white); r(6, 11, 4, 1, skinD); }
    else if (o === 'spacesuit') { arms(5, oc, metalD, metal); torso(3, 11, 10, 8, oc); r(5, 13, 6, 3, '#1c2530'); p(6, 14, ac); p(8, 14, '#ff4d4d'); p(9, 14, '#39c5ff'); r(3, 18, 10, 1, metalD); r(3, 11, 10, 1, metalL); }
    else if (o === 'trench') { arms(6, oc, ocD, skin); torso(2, 11, 12, 11, oc); r(3, 10, 3, 3, ocL); r(10, 10, 3, 3, ocL); r(7, 11, 2, 3, white); r(2, 16, 12, 1, ocD); p(7, 16, gold); p(8, 16, gold); p(6, 13, ocD); p(6, 19, ocD); p(9, 19, ocD); }
    else if (o === 'jacket') { arms(7, oc, ocD, skin); torso(3, 11, 10, 8, oc); r(3, 10, 10, 1, ocL); r(6, 11, 4, 3, ac); r(8, 11, 1, 8, ocL); r(1, 17, 2, 1, skin); r(13, 17, 2, 1, skin); }
    else if (o === 'hazmat') { arms(7, oc, ocD, '#111820'); torso(3, 11, 10, 11, oc); r(4, 18, 4, 4, oc); r(8, 18, 4, 4, oc); r(3, 16, 10, 1, ac); r(9, 13, 3, 2, ac); r(7, 11, 2, 11, shade(oc, -0.15)); r(1, 17, 2, 1, '#111820'); r(13, 17, 2, 1, '#111820'); }
    else if (o === 'tactical') { arms(7, oc, null, skin); torso(3, 11, 10, 8, oc); r(4, 12, 8, 6, ocD); r(4, 16, 3, 2, ocL); r(9, 16, 3, 2, ocL); r(5, 12, 1, 4, ocL); r(10, 12, 1, 4, ocL); r(4, 16, 3, 1, ac); r(1, 17, 2, 1, '#111820'); r(13, 17, 2, 1, '#111820'); }
    else if (o === 'armor') { arms(7, metalD, null, metal); torso(3, 11, 10, 8, metal); r(4, 12, 8, 3, metalL); r(7, 14, 2, 2, ac); r(1, 10, 3, 3, oc); r(12, 10, 3, 3, oc); r(3, 18, 10, 1, metalD); r(4, 18, 4, 4, metal); r(8, 18, 4, 4, metal); }
    else if (o === 'uniform') { arms(6, oc, ac, skin); torso(3, 11, 10, 8, oc); r(7, 11, 2, 2, white); for (const y of [12, 14, 16]) { p(6, y, gold); p(9, y, gold); } r(3, 10, 2, 1, ac); r(11, 10, 2, 1, ac); r(1, 17, 2, 1, skin); r(13, 17, 2, 1, skin); }
    else if (o === 'vest') { arms(4, white, null, skin); torso(3, 11, 10, 8, white); r(4, 11, 3, 8, oc); r(9, 11, 3, 8, oc); r(7, 12, 2, 5, ac); r(7, 11, 2, 1, skinD); }
    else { arms(4, oc, null, skin); torso(3, 11, 10, 8, oc); }

    // ---- head
    if (robot) {
      r(4, 3, 8, 8, skin); r(4, 3, 8, 1, shade(skin, 0.25)); r(11, 3, 1, 8, shade(skin, -0.3)); r(4, 10, 8, 1, shade(skin, -0.3));
      r(5, 5, 6, 3, '#06120c'); r(5, 6, 2, 2, ac); r(9, 6, 2, 2, ac); p(5, 5, shade(ac, -0.5)); p(10, 5, shade(ac, -0.5));
      for (let x = 6; x <= 9; x++) p(x, 9, x % 2 ? metalD : dark); p(8, 0, ac); r(8, 1, 1, 2, metalD); p(3, 7, metalD); p(12, 7, metalD);
    } else {
      r(4, 3, 8, 8, skin); r(11, 4, 1, 7, skinD); r(4, 10, 8, 1, skinD); p(3, 7, skin); p(12, 7, skinD); p(5, 4, skinL); p(6, 4, skinL);
      const brow = av.hair === 'bald' ? skinD : hairD;
      p(6, 6, brow); p(9, 6, brow);
      if (blink) { p(6, 7, skinD); p(9, 7, skinD); } else { p(6, 7, dark); p(9, 7, dark); p(6, 7, '#101820'); }
      p(8, 8, skinD); r(7, 9, 2, 1, mix(skin, '#7a2a2a', 0.5));
    }

    // ---- facial hair
    if (!robot) {
      const f = { stubble: () => r(5, 9, 6, 2, mix(skin, hair, 0.5)), stache: () => r(6, 9, 4, 1, hairD),
        goatee: () => { r(6, 9, 4, 1, hairD); r(7, 10, 2, 2, hair); },
        beard: () => { r(4, 8, 1, 3, hair); r(11, 8, 1, 3, hair); r(5, 10, 6, 2, hair); r(5, 9, 2, 1, hair); r(9, 9, 2, 1, hair); p(7, 9, skinD); p(8, 9, skinD); } }[av.facial];
      if (f) f();
    }

    // ---- hair
    if (!robot && hw !== 'helmet') {
      const h = av.hair;
      if (h === 'short') { r(4, 2, 8, 2, hair); r(4, 4, 1, 2, hair); r(11, 4, 1, 2, hair); r(5, 4, 6, 1, hair); p(6, 2, hairL); p(7, 2, hairL); }
      else if (h === 'slick') { r(4, 2, 8, 2, hair); p(4, 4, hair); p(11, 4, hair); r(5, 4, 6, 1, hairD); p(6, 3, hairL); p(7, 3, hairL); p(8, 3, hairL); }
      else if (h === 'long') { r(4, 2, 8, 2, hair); r(4, 4, 1, 6, hair); r(11, 4, 1, 6, hair); r(5, 4, 6, 1, hair); p(6, 2, hairL); }
      else if (h === 'spiky') { r(4, 2, 8, 2, hair); r(5, 4, 6, 1, hair); for (const x of [4, 6, 8, 10]) p(x, 1, hair); for (const x of [5, 7, 9]) p(x, 0, hair); p(6, 2, hairL); }
      else if (h === 'wild') { r(3, 2, 10, 3, hair); r(2, 3, 1, 4, hair); r(13, 3, 1, 4, hair); r(3, 5, 1, 2, hair); r(12, 5, 1, 2, hair); for (const x of [4, 7, 10, 12]) p(x, 1, hair); for (const x of [5, 9]) p(x, 0, hair); p(6, 2, hairL); p(9, 3, hairL); }
      else if (h === 'mohawk') { r(7, 0, 2, 4, hair); r(6, 3, 4, 1, hair); p(7, 0, hairL); r(4, 3, 1, 1, hairD); r(11, 3, 1, 1, hairD); }
      else if (h === 'bun') { r(4, 2, 8, 2, hair); r(4, 4, 1, 2, hair); r(11, 4, 1, 2, hair); r(5, 4, 6, 1, hair); r(7, 0, 2, 2, hair); p(7, 0, hairL); }
      else { p(6, 3, skinL); p(7, 3, skinL); } // bald
    }

    // ---- eyewear
    const ew = av.eyewear, frameC = '#161b22';
    if (ew === 'glasses') { r(5, 6, 3, 3, frameC); r(8, 6, 3, 3, frameC); p(6, 7, '#cfe9ff'); p(9, 7, '#cfe9ff'); p(6, 7, '#e8f7ff'); }
    else if (ew === 'round') { for (const x of [5, 8]) { r(x, 6, 3, 3, '#06090c'); p(x, 6, skin); p(x + 2, 6, skin); p(x, 8, skin); p(x + 2, 8, skin); p(x + 1, 7, '#4a5a5a'); } r(7, 7, 1, 1, '#06090c'); }
    else if (ew === 'shades') { r(4, 6, 8, 2, '#07090b'); p(6, 6, '#3a4650'); p(9, 6, '#3a4650'); p(4, 8, skinD); }
    else if (ew === 'visor') { r(4, 6, 8, 2, ac); r(4, 6, 8, 1, shade(ac, 0.5)); p(4, 7, dark); p(11, 7, dark); }
    else if (ew === 'goggles') { r(3, 6, 10, 1, '#222a33'); r(5, 6, 3, 3, frameC); r(8, 6, 3, 3, frameC); p(6, 7, ac); p(9, 7, ac); }

    // ---- headwear
    if (hw === 'porkpie') { r(3, 3, 10, 1, hat); r(5, 0, 6, 3, hat); r(10, 0, 1, 3, hatD); r(5, 2, 6, 1, ac); p(8, 0, hatD); r(5, 0, 2, 1, hatL); }
    else if (hw === 'fedora') { r(2, 3, 12, 1, hat); r(5, 0, 6, 3, hat); r(7, 0, 2, 1, hatD); r(5, 2, 6, 1, ac); r(10, 0, 1, 3, hatD); r(2, 3, 12, 1, hatD); r(3, 3, 8, 1, hat); }
    else if (hw === 'cap') { r(4, 1, 8, 3, hat); r(4, 4, 8, 1, hatD); p(8, 0, hatD); r(5, 1, 3, 1, hatL); }
    else if (hw === 'beanie') { r(4, 1, 8, 3, hat); r(4, 3, 8, 1, hatD); p(7, 0, ac); p(8, 0, ac); r(5, 1, 2, 1, hatL); }
    else if (hw === 'hood') { r(4, 2, 8, 2, hat); r(3, 3, 1, 8, hat); r(12, 3, 1, 8, hat); r(4, 4, 8, 1, shade(hat, -0.2)); }
    else if (hw === 'helmet') {
      r(3, 1, 10, 2, hat); r(2, 2, 2, 9, hat); r(12, 2, 2, 9, hat); r(3, 10, 10, 2, hat); r(13, 2, 1, 9, hatD); r(3, 1, 10, 1, shade(hat, 0.15)); r(3, 11, 10, 1, metalD);
      for (let y = 3; y <= 9; y++) for (let x = 4; x <= 11; x++) { const c = get(x, y); if (c) p(x, y, mix(c, '#a8e4ff', 0.26)); }
      p(5, 4, '#ffffff'); p(6, 3, '#e8f7ff'); p(10, 8, '#ffffff');
    }
    else if (hw === 'captain') { r(4, 0, 8, 3, hat); r(4, 3, 8, 1, dark); r(3, 4, 10, 1, dark); p(7, 1, gold); p(8, 1, gold); p(7, 2, gold); p(8, 2, gold); r(4, 0, 2, 1, shade(hat, 0.2)); }
    else if (hw === 'headset') { r(4, 2, 8, 1, hat); p(3, 3, hat); p(3, 4, hat); p(12, 3, hat); p(12, 4, hat); r(3, 5, 1, 3, hat); r(12, 5, 1, 3, hat); p(3, 5, hatL); p(4, 8, hat); p(5, 9, hat); p(6, 9, ac); }
    else if (hw === 'hardhat') { r(4, 1, 8, 3, hat); r(7, 0, 2, 1, hat); r(3, 4, 10, 1, hatD); r(5, 1, 2, 1, hatL); r(11, 1, 1, 3, hatD); }
    else if (hw === 'crown') { r(4, 1, 8, 2, gold); for (const x of [4, 7, 8, 11]) p(x, 0, gold); p(5, 1, '#fff3b0'); p(7, 1, '#ff3b3b'); p(8, 1, '#39c5ff'); r(4, 2, 8, 1, '#b8912a'); }

    // ---- accessory
    const ax = av.accessory;
    if (ax === 'earpiece') { p(3, 7, '#161b22'); p(3, 8, '#161b22'); p(3, 9, '#8b95a1'); p(4, 10, '#8b95a1'); }
    else if (ax === 'respirator') { r(5, 8, 6, 3, '#39493e'); r(4, 9, 1, 2, metal); r(11, 9, 1, 2, metal); p(7, 9, dark); p(8, 9, dark); p(7, 10, dark); p(8, 10, dark); r(4, 7, 1, 1, dark); r(11, 7, 1, 1, dark); }
    else if (ax === 'scarf') { r(3, 11, 10, 2, ac); r(9, 13, 2, 4, ac); r(9, 13, 1, 4, acD); r(3, 12, 10, 1, acD); }
    else if (ax === 'badge') { r(8, 11, 1, 2, ac); r(8, 13, 3, 3, white); p(9, 14, ac); }

    // ---- outline: any empty cell touching a filled cell
    const out = buf.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (buf[y * W + x]) continue;
      if ((x > 0 && buf[y * W + x - 1]) || (x < W - 1 && buf[y * W + x + 1]) || (y > 0 && buf[(y - 1) * W + x]) || (y < H - 1 && buf[(y + 1) * W + x])) out[y * W + x] = OUTLINE;
    }
    return out;
  }

  const cache = new Map();
  function sprite(av, frame) {
    const key = JSON.stringify(av) + '|' + frame;
    let c = cache.get(key);
    if (!c) {
      const buf = build(av, frame); c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'), id = x.createImageData(W, H);
      buf.forEach((col, i) => { if (!col) return; const [r, g, b] = rgb(col); id.data.set([r, g, b, 255], i * 4); });
      x.putImageData(id, 0, 0);
      if (cache.size > 400) cache.clear();
      cache.set(key, c);
    }
    return c;
  }
  // x,y = top-left of the padded sprite box. Frame: 0 idle, 1 typing, 2 blink.
  function draw(ctx, av, x, y, scale, frame) { ctx.imageSmoothingEnabled = false; ctx.drawImage(sprite(av, frame || 0), Math.round(x), Math.round(y), W * scale, H * scale); }
  function canvas(av, scale, frame) { const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale; c.className = 'sprite'; draw(c.getContext('2d'), av, 0, 0, scale, frame); return c; }
  // Idle agents blink now and then; busy agents type.
  function frameFor(id, now, busy) {
    if (busy) return Math.floor(now / 320) % 2;
    let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (now + h * 97) % 4200 < 130 ? 2 : 0;
  }
  window.Avatar = { W, H, draw, canvas, frameFor };
})();
