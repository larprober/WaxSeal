'use strict';
/*
 * Renders tools/banner.html to assets/banner.png with Electron's own compositor,
 * so the README hero is a crisp raster with no image library involved. Rendered
 * at 2x (force-device-scale-factor) for retina sharpness.
 *
 *   npm run banner
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Rendered 1:1 at a native size that fits within the physical screen, so the
// window is never clamped and the full banner is captured.
const W = 1600;
const H = 500;
const OUT = path.join(__dirname, '..', 'assets', 'banner.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0c0708',
  });

  await win.loadFile(path.join(__dirname, 'banner.html'));
  await new Promise((r) => setTimeout(r, 800));   // let fonts settle and a frame paint

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  const s = img.getSize();
  console.log('wrote ' + OUT + ' at ' + s.width + 'x' + s.height);

  win.destroy();
  app.quit();
});
