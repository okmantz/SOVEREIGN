'use strict';
// ComfyUI (local image and media generation). Runs on your machine, costs nothing, and never needs approval because
// it sends nothing to the outside world. See ../comfy.js for how agents use it.
const comfy = require('../comfy');
const { assert } = require('../util');

module.exports = {
  label: 'ComfyUI', source: 'comfyui',
  blurb: 'Free image generation on your own computer. Agents make product photos, ads, hero images and social visuals, and the Builder puts them into your website. Start ComfyUI first, then press Test connection.',
  fields: [
    { key: 'baseUrl', label: 'ComfyUI address', placeholder: comfy.DEFAULT_URL, help: 'Usually http://127.0.0.1:8188 (the desktop app often uses http://127.0.0.1:8000).', optional: true },
    { key: 'checkpoint', label: 'Model (checkpoint)', optional: true, placeholder: 'Leave blank to use the first one installed', help: 'The exact file name shown in ComfyUI. Test connection lists what is installed.' },
    { key: 'width', label: 'Default width', optional: true, placeholder: '1024', help: '1024 suits SDXL-style models. Use 512 for older SD 1.5 models.' },
    { key: 'height', label: 'Default height', optional: true, placeholder: '1024' },
    { key: 'timeoutSec', label: 'Give up on one image after (seconds)', optional: true, placeholder: '240' },
    { key: 'token', label: 'Access token', secret: true, optional: true, help: 'Only if your ComfyUI sits behind a proxy that needs one. Leave blank for a normal local install.' }
  ],
  async test(c, sec) {
    const base = comfy.normalize(c.config.baseUrl); assert(comfy.httpUrl(base), 'That does not look like a web address.');
    const info = await comfy.ping(base, sec.token), models = await comfy.checkpoints(base, sec.token).catch(() => []);
    const patch = {}; if (!c.config.baseUrl) patch.baseUrl = base; if (!c.config.checkpoint && models[0] && !c.workflow) patch.checkpoint = models[0];
    const using = c.config.checkpoint || patch.checkpoint;
    return { patchConfig: patch, detail: `Connected to ComfyUI${info.version ? ' ' + info.version : ''}${info.device ? ' on ' + info.device : ''}. ${models.length ? `${models.length} model${models.length > 1 ? 's' : ''} installed${using ? `; using ${using}` : ''}.` : c.workflow ? 'Using your custom workflow.' : 'No models installed yet: add a checkpoint in ComfyUI before generating.'}` };
  }
};
