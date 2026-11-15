// Post-processes `expo export --platform web`.
// Fonts sit under assets/node_modules/…, a path some
// static hosts (Netlify among them) refuse to upload. This moves them to assets/fonts/
// and rewrites the references. Usage: node flatten-web.mjs <dist dir>
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const from = join(dist, 'assets', 'node_modules');
const moved = new Map();
mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
for (const file of walk(from)) {
  const rel = file.slice(dist.length + 1).split('\\').join('/');
  const to = `assets/fonts/${basename(file)}`;
  renameSync(file, join(dist, to));
  moved.set(rel, to);
}
rmSync(from, { recursive: true });
const jsDir = join(dist, '_expo', 'static', 'js', 'web');
for (const f of readdirSync(jsDir)) {
  let src = readFileSync(join(jsDir, f), 'utf8');
  for (const [a, b] of moved) src = src.split(a).join(b);
  writeFileSync(join(jsDir, f), src);
}
console.log(`moved ${moved.size} font files to assets/fonts`);
// Home-screen icon and full-screen mode when the site is added to an iPhone's home screen.
const indexPath = join(dist, 'index.html');
const head = [
  '<link rel="apple-touch-icon" href="apple-touch-icon.png"/>',
  '<link rel="manifest" href="manifest.json"/>',
  '<meta name="apple-mobile-web-app-capable" content="yes"/>',
  '<meta name="mobile-web-app-capable" content="yes"/>',
  '<meta name="apple-mobile-web-app-title" content="Perp Duel"/>',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>',
  '<meta name="theme-color" content="#191330"/>',
  '<style>html,body{background:#191330}</style>',
].join('');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('</head>', `${head}</head>`).replace('shrink-to-fit=no', 'shrink-to-fit=no, viewport-fit=cover'));

