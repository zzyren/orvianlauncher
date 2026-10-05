// Script auxiliar: genera .github/workflows/release.yml
// Ejecutar con: node scripts/write-release-yml.cjs
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.github', 'workflows');
fs.mkdirSync(dir, { recursive: true });

const content = [
  'name: Build and Release',
  '',
  'on:',
  '  push:',
  '    tags:',
  "      - 'v*.*.*'",
  '',
  'permissions:',
  '  contents: write',
  '',
  'jobs:',
  '  build-windows:',
  '    runs-on: windows-latest',
  '',
  '    steps:',
  '      - name: Checkout repository',
  '        uses: actions/checkout@v4',
  '',
  '      - name: Setup Node.js',
  '        uses: actions/setup-node@v4',
  '        with:',
  "          node-version: '20'",
  "          cache: 'npm'",
  '',
  '      - name: Install dependencies',
  '        run: npm ci',
  '',
  '      - name: Build and publish to GitHub Releases',
  '        env:',
  '          GH_TOKEN: ${{ secrets.GH_TOKEN }}',
  '        run: npm run dist:win:publish',
].join('\n');

const outPath = path.join(dir, 'release.yml');
fs.writeFileSync(outPath, content, 'utf8');
console.log('Creado:', outPath);
