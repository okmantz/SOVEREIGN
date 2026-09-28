// Procedural pixel avatars: 8 x 12 sprite grid, drawn from a small config. No image assets needed.
(function () {
  function draw(ctx, av, x, y, s, frame) {
    const px = (cx, cy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x + cx * s), Math.round(y + cy * s), w * s, h * s); };
    const step = frame % 2 === 1;
    px(2, 9, 2, step ? 2 : 3, '#232a52'); px(4, 9, 2, step ? 3 : 2, '#232a52');           // legs
    px(1, 5, 6, 4, av.outfit); px(0, 5, 1, 3, av.outfit); px(7, 5, 1, 3, av.outfit);       // body + arms
    px(0, 8, 1, 1, av.skin); px(7, 8, 1, 1, av.skin);                                       // hands
    px(1, 1, 6, 4, av.skin);                                                                // head
    const hs = av.hairStyle | 0;                                                            // hair
    if (hs === 0) px(1, 0, 6, 2, av.hair);
    else if (hs === 1) { px(1, 0, 6, 2, av.hair); px(0, 1, 1, 5, av.hair); px(7, 1, 1, 5, av.hair); }
    else if (hs === 2) { px(1, 1, 6, 1, av.hair); px(2, 0, 1, 1, av.hair); px(4, 0, 1, 1, av.hair); px(6, 0, 1, 1, av.hair); }
    else px(1, 1, 6, 1, av.hair);
    px(2, 3, 1, 1, '#14182b'); px(5, 3, 1, 1, '#14182b');                                   // eyes
    if (av.accessory === 'glasses') { px(1, 3, 1, 1, '#dfe6ff'); px(3, 3, 2, 1, '#dfe6ff'); px(6, 3, 1, 1, '#dfe6ff'); }
    if (av.accessory === 'visor') px(1, 3, 6, 1, '#4fd1b5');
    if (av.accessory === 'headset') { px(0, 2, 1, 3, '#9aa3d0'); px(7, 2, 1, 3, '#9aa3d0'); px(1, 0, 6, 1, '#9aa3d0'); }
    if (av.accessory === 'crown') { px(1, -1, 6, 1, '#e6b450'); px(1, -2, 1, 1, '#e6b450'); px(3, -2, 2, 1, '#e6b450'); px(6, -2, 1, 1, '#e6b450'); }
  }
  window.Avatar = { draw, W: 8, H: 12 };
})();
