const fs = require('fs');
const path = require('path');

// --- Patch 1: @xmcl/core/utils.js ---
const coreDir = path.join(__dirname, '..', 'node_modules', '@xmcl', 'core');
if (fs.existsSync(coreDir)) {
  const utilsFile = path.join(coreDir, 'utils.js');
  fs.writeFileSync(
    utilsFile,
    `module.exports = {
  isNotNull: function(v) { return v !== undefined && v !== null; },
  exists: async function() { return false; },
  validateSha1: async function() { return true; },
  checksum: async function() { return ""; }
};
`
  );
  console.log('[patch-xmcl] Patched @xmcl/core/utils.js');
}

// --- Patch 2: @xmcl/user/dist/index.js — replace require("uuid") with inline v4 ---
const userDist = path.join(__dirname, '..', 'node_modules', '@xmcl', 'user', 'dist', 'index.js');
if (fs.existsSync(userDist)) {
  let src = fs.readFileSync(userDist, 'utf8');

  // Only patch if the problematic require is still there
  if (src.includes('require("uuid")')) {
    // Inline uuid v4 implementation (RFC 4122 compliant) — no deps
    const uuidInline = `var import_uuid = {
  v4: function() {
    var bytes = new Uint8Array(16);
    for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.from(bytes).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
};`;
    src = src.replace('var import_uuid = require("uuid");', uuidInline);
    fs.writeFileSync(userDist, src, 'utf8');
    console.log('[patch-xmcl] Patched @xmcl/user/dist/index.js (inlined uuid v4)');
  } else {
    console.log('[patch-xmcl] @xmcl/user/dist/index.js already patched, skipping.');
  }
}
