const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  process.exit(0);
}

try {
  const electronDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  const electronExe = path.join(electronDist, 'electron.exe');
  const orvianExe = path.join(electronDist, 'Orvian.exe');
  const pathFile = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
  const iconPath = path.join(__dirname, '..', 'public', 'logo.ico');
  const rceditExe = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');

  if (fs.existsSync(electronExe)) {
    if (!fs.existsSync(orvianExe)) {
      fs.copyFileSync(electronExe, orvianExe);
    }

    if (fs.existsSync(rceditExe) && fs.existsSync(iconPath)) {
      const applyRcedit = (target) => {
        try {
          spawnSync(
            rceditExe,
            [
              target,
              '--set-version-string', 'FileDescription', 'Orvian Launcher',
              '--set-version-string', 'ProductName', 'Orvian Launcher',
              '--set-version-string', 'InternalName', 'Orvian',
              '--set-version-string', 'OriginalFilename', 'Orvian.exe',
              '--set-icon', iconPath
            ],
            { stdio: 'ignore' }
          );
        } catch (_) {}
      };

      applyRcedit(orvianExe);
      applyRcedit(electronExe);
    }

    fs.writeFileSync(pathFile, 'Orvian.exe', 'utf-8');
    console.log('[patch-electron-dev] Dev executable patched as Orvian.exe with Orvian metadata & icon.');
  }
} catch (err) {
  console.warn('[patch-electron-dev] Warning: Could not patch dev electron binary (likely in use):', err.message);
}
