const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, readAllEntries, readEntry } = require('@xmcl/unzip');

async function sha256Stream(readable) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    readable.on('data', chunk => hash.update(chunk));
    readable.on('error', reject);
    readable.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const mrpackPath = 'C:\\Users\\jugador\\Downloads\\Orvian.mrpack';
  if (!fs.existsSync(mrpackPath)) {
    console.error('No se encuentra Orvian.mrpack en', mrpackPath);
    process.exit(1);
  }

  console.log('Abriendo', mrpackPath);
  const zip = await open(mrpackPath);
  const entries = await readAllEntries(zip);

  const indexEntry = entries.find(e => e.fileName === 'modrinth.index.json');
  if (!indexEntry) throw new Error('No se encontró modrinth.index.json');

  const indexBuf = await readEntry(zip, indexEntry);
  const index = JSON.parse(indexBuf.toString('utf8'));

  const overridesOutDir = path.join(__dirname, '..', 'pack', 'overrides');
  fs.mkdirSync(overridesOutDir, { recursive: true });

  const manifestFiles = [];

  // 1. Process overrides
  console.log('Procesando overrides...');
  const overrideEntries = entries.filter(e => {
    if (!e.fileName.startsWith('overrides/') || e.fileName.endsWith('/')) return false;
    const rel = e.fileName.slice('overrides/'.length);
    if (rel.startsWith('.bobby/')) return false;
    if (rel.startsWith('modernfix/structureCacheV1/')) return false;
    if (rel.startsWith('xaero/')) return false;
    if (rel.startsWith('XaeroWaypoints')) return false;
    if (rel.startsWith('mods/.connector/')) return false;
    if (['fabricloader.log', 'hotbar.nbt', 'usercache.json', 'usernamecache.json', 'servers.dat_old'].includes(rel)) return false;
    if (rel.startsWith('config/inventoryprofilesnext/') && !rel.startsWith('config/inventoryprofilesnext/integrationHints/')) return false;
    if (['config/voicechat/category-volumes.properties', 'config/voicechat/player-volumes.properties', 'config/voicechat/username-cache.json'].includes(rel)) return false;
    return true;
  });

  for (const entry of overrideEntries) {
    const rel = entry.fileName.slice('overrides/'.length);
    const content = await readEntry(zip, entry);
    const targetFile = path.join(overridesOutDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, content);

    const hash = await sha256Buffer(content);
    let type = 'other';
    if (rel.startsWith('config/')) type = 'config';
    else if (rel.startsWith('mods/')) type = 'mod';
    else if (rel.startsWith('defaultconfigs/')) type = 'defaultconfig';

    const isUserSetting = rel === 'options.txt' || rel === 'servers.dat' || type === 'config';
    manifestFiles.push({
      path: rel,
      sha256: hash,
      size: content.length,
      url: `https://raw.githubusercontent.com/zzyren/orvianmodpack/main/overrides/${rel}`,
      type: type,
      required: !isUserSetting,
      userMutable: isUserSetting,
      userDeletable: false
    });
  }

  console.log(`Overrides guardados: ${overrideEntries.length}`);

  // 2. Process Modrinth files
  console.log(`Procesando ${index.files.length} archivos de Modrinth...`);
  const cacheDir = path.join(__dirname, '..', '.cache', 'mods');
  fs.mkdirSync(cacheDir, { recursive: true });

  const queue = [...index.files];
  const CONCURRENCY = 6;
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) break;

      const filename = path.basename(file.path);
      const cachedPath = path.join(cacheDir, filename);

      let hash = '';
      let size = 0;

      if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size === file.fileSize) {
        // verify sha1
        const buf = fs.readFileSync(cachedPath);
        const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
        if (sha1.toLowerCase() === file.hashes.sha1.toLowerCase()) {
          hash = crypto.createHash('sha256').update(buf).digest('hex');
          size = buf.length;
        }
      }

      if (!hash) {
        const url = file.downloads[0];
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Error descargando ${url}: ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        hash = crypto.createHash('sha256').update(buf).digest('hex');
        size = buf.length;
        fs.writeFileSync(cachedPath, buf);
      }

      manifestFiles.push({
        path: file.path,
        sha256: hash,
        size: size,
        url: file.downloads[0],
        type: file.path.startsWith('mods/') ? 'mod' : 'other',
        required: true,
        userMutable: false,
        userDeletable: false
      });

      completed++;
      if (completed % 10 === 0 || completed === index.files.length) {
        console.log(`Progreso: ${completed}/${index.files.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const manifest = {
    schemaVersion: 1,
    pack: {
      id: 'orvian',
      name: 'Orvian',
      version: '1.0.0',
      minecraft: '1.20.1',
      loader: 'forge',
      forge: '47.4.23'
    },
    runtime: {
      java: 17
    },
    minimumLauncher: '0.1.0',
    publishedAt: new Date().toISOString(),
    changelog: [
      'Orvian Modpack v1.0.0 para Minecraft 1.20.1 Forge 47.4.23',
      'Configuraciones optimizadas y mods de rendimiento incluidos',
      'Servidor oficial payo.exaroton.me configurado'
    ],
    files: manifestFiles
  };

  const manifestPath = path.join(__dirname, '..', 'pack', 'orvian-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n¡Manifiesto generado con éxito en ${manifestPath}! Total de archivos: ${manifestFiles.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
