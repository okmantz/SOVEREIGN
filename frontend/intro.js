// The opening sequence: black screen, typed lines, each held then gone, then the station appears.
// Click, Escape, Space or Enter skips it. It can be turned off in Settings, and is instant for reduced-motion users.
(() => {
'use strict';
const LINES = ['Wake up, Neo...', 'The Matrix has you...', 'Follow the white rabbit.', 'Knock, knock, Neo.'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function play(enabled) {
  const box = document.getElementById('intro'), text = document.getElementById('intro-text'), line = box.querySelector('.intro-line');
  if (!enabled) { box.hidden = true; return Promise.resolve(); }
  box.hidden = false; box.classList.remove('out');
  let skipped = false, wake;
  const skip = () => { skipped = true; if (wake) wake(); };
  const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const onKey = (e) => { if (['Escape', ' ', 'Enter'].includes(e.key) || e.key.length === 1) { e.preventDefault(); skip(); } };
  box.addEventListener('pointerdown', skip); window.addEventListener('keydown', onKey);
  return (async () => {
    await wait(700);
    for (const [i, s] of LINES.entries()) {
      if (skipped) break;
      text.textContent = ''; line.classList.remove('gone');
      if (reduced()) text.textContent = s;
      else for (const ch of s) { if (skipped) break; text.textContent += ch; await wait(ch === '.' || ch === ',' ? 190 : 62 + Math.random() * 38); }
      if (skipped) break;
      await wait(i === LINES.length - 1 ? 1900 : 2300); // hold
      line.classList.add('gone'); await wait(i === LINES.length - 1 ? 200 : 700); // the line vanishes and the screen stays black
    }
    box.classList.add('out'); await sleep(skipped ? 250 : 1100);
    box.hidden = true; text.textContent = '';
    box.removeEventListener('pointerdown', skip); window.removeEventListener('keydown', onKey);
  })();
}
window.Intro = { play, LINES };
})();
