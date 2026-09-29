'use strict';
// A short guided tour, shown once right after the first goal is saved. Five steps, each with Next and Skip.
// It dims the page, cuts a spotlight around the part being explained, and puts a small card beside it.
// Keys: Enter or → for Next, Esc to skip. It is remembered in this browser; Settings has a Replay button.
(() => {
  const KEY = 'sov.tutorial';
  const STEPS = [
    { target: '#drawer', title: 'This is your plan', text: 'The Director just drafted milestones for your goal. Read them, change anything you like, then approve. Nothing runs until you say so.', open: 'journey' },
    { target: '#view', title: 'This is your team\'s office', text: 'Each room is a department and each desk is an agent. Once you approve, they work here, several at a time. Click any room or agent to look closer.' },
    { target: '#guide', title: 'Follow along here', text: 'This bar always shows where you are and the next thing that needs you. The team keeps working on everything else in the meantime.' },
    { target: 'button[title="Outbox"]', title: 'Results land in the Outbox', text: 'The business plan, copy, images and even a website preview all show up here. Nothing is sent to anyone without your approval.', pad: 6 },
    { target: '#chat', title: 'Talk to the Director', text: 'Ask questions or give orders here. The team checks its own work, fixes it and keeps going until your goal is reached. You can pause any time.' }
  ];
  let state = null;

  const seen = () => { try { return localStorage.getItem(KEY) === 'done'; } catch (_) { return false; } };
  const remember = () => { try { localStorage.setItem(KEY, 'done'); } catch (_) { /* private mode: it will just show again next time */ } };

  function place(card, rect) {
    const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, m = 14;
    const tries = rect ? [
      { x: rect.right + m, y: rect.top + 8 }, { x: rect.left - cw - m, y: rect.top + 8 },      // beside it
      { x: rect.left + 8, y: rect.bottom + m }, { x: rect.left + 8, y: rect.top - ch - m },    // below, above
      { x: rect.left + rect.width / 2 - cw / 2, y: rect.bottom - ch - m }                     // inside, along the bottom (large targets)
    ] : [];
    const fits = (p) => p.x >= 8 && p.y >= 8 && p.x + cw <= vw - 8 && p.y + ch <= vh - 8;
    const p = tries.find(fits) || { x: (vw - cw) / 2, y: (vh - ch) / 2 };
    card.style.left = Math.max(8, Math.min(vw - cw - 8, p.x)) + 'px'; card.style.top = Math.max(8, Math.min(vh - ch - 8, p.y)) + 'px';
  }
  function render() {
    if (!state) return; const step = STEPS[state.i], last = state.i === STEPS.length - 1;
    const el = document.querySelector(step.target), r = el && el.getBoundingClientRect(), ok = r && r.width > 0 && r.height > 0, pad = step.pad == null ? 4 : step.pad;
    const { spot, card, dots, title, text, next } = state.nodes;
    if (ok) { Object.assign(spot.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' }); }
    else spot.style.display = 'none'; // the target is not on screen (narrow window): show the card in the middle instead
    title.textContent = step.title; text.textContent = step.text; next.textContent = last ? 'Got it' : 'Next';
    dots.replaceChildren(...STEPS.map((_, i) => Object.assign(document.createElement('i'), { className: 'tdot' + (i === state.i ? ' on' : i < state.i ? ' past' : '') })));
    card.querySelector('.tcount').textContent = `Step ${state.i + 1} of ${STEPS.length}`;
    place(card, ok ? r : null); next.focus({ preventScroll: true });
  }
  function go(n) {
    if (!state) return; if (n >= STEPS.length) return finish();
    state.i = n; const step = STEPS[n]; if (step.open && window.SOV && SOV.openDrawer && SOV.drawer !== step.open) SOV.openDrawer(step.open);
    requestAnimationFrame(() => requestAnimationFrame(render)); // let the panel draw before measuring it
  }
  function finish() {
    if (!state) return; remember(); document.removeEventListener('keydown', state.key, true); removeEventListener('resize', state.resize); state.root.remove(); state = null;
  }
  function start({ force = false } = {}) {
    if (state || (!force && seen())) return;
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const spot = el('div', { className: 'tspot' }), title = el('h3', { className: 'ttitle', id: 'tut-title' }), text = el('p', { className: 'ttext', id: 'tut-text' }), dots = el('div', { className: 'tdots' });
    const next = el('button', { type: 'button', className: 'btn primary', onclick: () => go(state.i + 1) }), skip = el('button', { type: 'button', className: 'btn', onclick: finish }, 'Skip tutorial');
    const card = el('div', { className: 'tcard', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tut-title', 'aria-describedby': 'tut-text' }, el('div', { className: 'tcount muted' }), title, text, el('div', { className: 'trow2' }, dots, el('div', { className: 'tbtns' }, skip, next)));
    const root = el('div', { id: 'tutorial' }, el('div', { className: 'tshield' }), spot, card); // the shield keeps stray clicks from reaching the app behind
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); } else if (e.key === 'Enter' || e.key === 'ArrowRight') { if (document.activeElement === skip) return; e.preventDefault(); e.stopPropagation(); go(state.i + 1); } };
    const resize = () => render();
    state = { i: 0, root, key, resize, nodes: { spot, card, dots, title, text, next } };
    document.body.append(root); document.addEventListener('keydown', key, true); addEventListener('resize', resize); go(0);
  }
  window.SOV = window.SOV || {}; SOV.startTutorial = start; SOV.replayTutorial = () => start({ force: true }); SOV.tutorialSeen = seen;
})();
