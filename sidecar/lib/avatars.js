'use strict';
// Avatar catalog. The renderer lives in frontend/avatar.js; this file is the source of truth for what is allowed.
const OPTIONS = {
  head:      ['human', 'robot'],
  hair:      ['bald', 'short', 'slick', 'long', 'spiky', 'wild', 'mohawk', 'bun'],
  facial:    ['none', 'stubble', 'goatee', 'beard', 'stache'],
  eyewear:   ['none', 'glasses', 'round', 'shades', 'visor', 'goggles'],
  headwear:  ['none', 'porkpie', 'fedora', 'cap', 'beanie', 'hood', 'helmet', 'captain', 'headset', 'hardhat', 'crown'],
  outfit:    ['tee', 'suit', 'labcoat', 'hoodie', 'spacesuit', 'trench', 'jacket', 'hazmat', 'tactical', 'armor', 'uniform', 'vest'],
  accessory: ['none', 'earpiece', 'respirator', 'scarf', 'badge']
};
const PALETTE = {
  skin:   ['#f6dcc3', '#e8bd96', '#d09b6d', '#a8734a', '#7a4d30', '#523222', '#c9d6c9', '#9fe0c0'],
  hair:   ['#0d0f12', '#2b1b12', '#5a3a22', '#a4682e', '#d9b25a', '#d8dbe0', '#b8462f', '#3f6bd1', '#37e08a', '#c34fe0'],
  outfit: ['#0e1116', '#1c2530', '#2a3140', '#e9edf2', '#c9a13a', '#1f6f4a', '#2b5fb0', '#b23a3a', '#5b3fa0', '#d9d9d9', '#d8c832', '#7a5a3a'],
  accent: ['#00ff88', '#39c5ff', '#ff4d4d', '#ffcc33', '#ff5ecf', '#ffffff', '#ff8a2b', '#8b7be0']
};

const P = (label, blurb, c) => ({ label, blurb, cfg: c });
const PRESETS = {
  commander: P('Commander', 'Sharp suit, gold crown. The Director\'s default look.', { head: 'human', skin: '#e8bd96', hair: 'slick', hairColor: '#0d0f12', facial: 'none', eyewear: 'shades', headwear: 'crown', hatColor: '#c9a13a', outfit: 'suit', outfitColor: '#0e1116', accent: '#00ff88', accessory: 'earpiece' }),
  astronaut: P('Astronaut', 'White pressure suit, reflective visor.', { head: 'human', skin: '#e8bd96', hair: 'short', hairColor: '#5a3a22', facial: 'none', eyewear: 'none', headwear: 'helmet', hatColor: '#e9edf2', outfit: 'spacesuit', outfitColor: '#e9edf2', accent: '#ff8a2b', accessory: 'none' }),
  chemist: P('The Chemist', 'Black pork-pie hat, dark shades, goatee.', { head: 'human', skin: '#e8bd96', hair: 'bald', hairColor: '#d8dbe0', facial: 'goatee', eyewear: 'shades', headwear: 'porkpie', hatColor: '#0e1116', outfit: 'jacket', outfitColor: '#1c2530', accent: '#1f6f4a', accessory: 'none' }),
  guide: P('The Guide', 'Long black coat, round dark glasses, calm authority.', { head: 'human', skin: '#7a4d30', hair: 'bald', hairColor: '#0d0f12', facial: 'goatee', eyewear: 'round', headwear: 'none', hatColor: '#0e1116', outfit: 'trench', outfitColor: '#0e1116', accent: '#00ff88', accessory: 'none' }),
  suit_agent: P('Suit', 'Black suit, tie, earpiece, shades.', { head: 'human', skin: '#f6dcc3', hair: 'slick', hairColor: '#2b1b12', facial: 'none', eyewear: 'shades', headwear: 'none', hatColor: '#0e1116', outfit: 'suit', outfitColor: '#1c2530', accent: '#ff4d4d', accessory: 'earpiece' }),
  hacker: P('Hacker', 'Hood up, green visor, night-shift energy.', { head: 'human', skin: '#c9d6c9', hair: 'short', hairColor: '#0d0f12', facial: 'stubble', eyewear: 'visor', headwear: 'hood', hatColor: '#0e1116', outfit: 'hoodie', outfitColor: '#0e1116', accent: '#00ff88', accessory: 'none' }),
  cyborg: P('Cyborg', 'Chrome head, red optic, plated armor.', { head: 'robot', skin: '#aab6c4', hair: 'bald', hairColor: '#0d0f12', facial: 'none', eyewear: 'none', headwear: 'none', hatColor: '#2a3140', outfit: 'armor', outfitColor: '#b23a3a', accent: '#ff4d4d', accessory: 'none' }),
  scientist: P('Scientist', 'Wild white hair, round glasses, lab coat.', { head: 'human', skin: '#f6dcc3', hair: 'wild', hairColor: '#d8dbe0', facial: 'stache', eyewear: 'glasses', headwear: 'none', hatColor: '#e9edf2', outfit: 'labcoat', outfitColor: '#e9edf2', accent: '#39c5ff', accessory: 'none' }),
  captain: P('Captain', 'Navy uniform, peaked cap, gold trim.', { head: 'human', skin: '#d09b6d', hair: 'short', hairColor: '#d8dbe0', facial: 'beard', eyewear: 'none', headwear: 'captain', hatColor: '#e9edf2', outfit: 'uniform', outfitColor: '#2a3140', accent: '#ffcc33', accessory: 'none' }),
  noir: P('Noir', 'Fedora, tan trench coat, five o\'clock shadow.', { head: 'human', skin: '#e8bd96', hair: 'short', hairColor: '#5a3a22', facial: 'stubble', eyewear: 'none', headwear: 'fedora', hatColor: '#3a2f22', outfit: 'trench', outfitColor: '#a08055', accent: '#ffcc33', accessory: 'scarf' }),
  trader: P('Trader', 'Vest, tie and a headset. Always closing.', { head: 'human', skin: '#a8734a', hair: 'slick', hairColor: '#0d0f12', facial: 'none', eyewear: 'none', headwear: 'headset', hatColor: '#2a3140', outfit: 'vest', outfitColor: '#2b5fb0', accent: '#ffcc33', accessory: 'none' }),
  operator: P('Operator', 'Black beanie, tactical rig, earpiece.', { head: 'human', skin: '#523222', hair: 'short', hairColor: '#0d0f12', facial: 'beard', eyewear: 'none', headwear: 'beanie', hatColor: '#0e1116', outfit: 'tactical', outfitColor: '#2a3140', accent: '#00ff88', accessory: 'earpiece' }),
  robot: P('Robot', 'Boxy blue unit with antenna and a friendly visor.', { head: 'robot', skin: '#8fb4d9', hair: 'bald', hairColor: '#0d0f12', facial: 'none', eyewear: 'none', headwear: 'none', hatColor: '#2a3140', outfit: 'armor', outfitColor: '#2b5fb0', accent: '#39c5ff', accessory: 'none' }),
  engineer: P('Engineer', 'Yellow hard hat and a hi-vis jacket.', { head: 'human', skin: '#d09b6d', hair: 'short', hairColor: '#2b1b12', facial: 'stache', eyewear: 'goggles', headwear: 'hardhat', hatColor: '#d8c832', outfit: 'jacket', outfitColor: '#ff8a2b', accent: '#ffcc33', accessory: 'none' }),
  cook: P('Lab Cook', 'Yellow hazmat suit, respirator, goggles.', { head: 'human', skin: '#e8bd96', hair: 'bald', hairColor: '#d8dbe0', facial: 'none', eyewear: 'goggles', headwear: 'none', hatColor: '#d8c832', outfit: 'hazmat', outfitColor: '#d8c832', accent: '#0e1116', accessory: 'respirator' }),
  founder: P('Founder', 'Cap, hoodie and too much coffee.', { head: 'human', skin: '#f6dcc3', hair: 'short', hairColor: '#a4682e', facial: 'stubble', eyewear: 'none', headwear: 'cap', hatColor: '#1f6f4a', outfit: 'hoodie', outfitColor: '#2a3140', accent: '#00ff88', accessory: 'none' }),
  diplomat: P('Diplomat', 'Navy suit, side part, reading glasses.', { head: 'human', skin: '#d09b6d', hair: 'long', hairColor: '#5a3a22', facial: 'none', eyewear: 'glasses', headwear: 'none', hatColor: '#0e1116', outfit: 'suit', outfitColor: '#2b5fb0', accent: '#ffcc33', accessory: 'badge' })
};

const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

function clean(a, fallback) {
  const f = fallback || PRESETS.founder.cfg;
  if (!a || typeof a !== 'object') return { ...f };
  const out = {
    head: pick(a.head, OPTIONS.head, f.head), hair: pick(a.hair, OPTIONS.hair, f.hair), facial: pick(a.facial, OPTIONS.facial, f.facial),
    eyewear: pick(a.eyewear, OPTIONS.eyewear, f.eyewear), headwear: pick(a.headwear, OPTIONS.headwear, f.headwear),
    outfit: pick(a.outfit, OPTIONS.outfit, f.outfit), accessory: pick(a.accessory, OPTIONS.accessory, f.accessory),
    skin: hex(a.skin, f.skin), hairColor: hex(a.hairColor, f.hairColor), outfitColor: hex(a.outfitColor, f.outfitColor),
    accent: hex(a.accent, f.accent), hatColor: hex(a.hatColor, f.hatColor)
  };
  if (typeof a.preset === 'string' && PRESETS[a.preset]) out.preset = a.preset;
  return out;
}
// v0.1 avatars had {skin, hair:'#hex', hairStyle, outfit:'#hex', accessory}. Detect and replace them.
const isLegacy = (a) => !a || typeof a.outfitColor !== 'string' || !OPTIONS.outfit.includes(a.outfit);
function fromPreset(key) { const p = PRESETS[key] || PRESETS.founder; return { ...p.cfg, preset: PRESETS[key] ? key : 'founder' }; }

module.exports = { OPTIONS, PALETTE, PRESETS, clean, isLegacy, fromPreset };
