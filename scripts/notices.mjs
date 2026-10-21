import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const rows = [];
mkdirSync('third_party/licenses', { recursive: true });
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || !existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const files = readdirSync(path).filter((f) =>
    /^(license|licence|copying|notice)(\.|$|-)/i.test(f),
  );
  const licenses = [];
  for (const f of files) {
    const target = `${pkg.name.replaceAll('/', '_').replaceAll('@', '')}-${pkg.version}-${f}`;
    copyFileSync(join(path, f), join('third_party/licenses', target));
    licenses.push(`licenses/${target}`);
  }
  rows.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || entry.license || 'see package',
    role: entry.dev ? 'development' : 'runtime',
    licenseFiles: licenses,
    modified: false,
  });
}
writeFileSync('third_party/inventory.json', JSON.stringify(rows, null, 2));
console.log(
  `Recorded ${rows.length} installed packages with license files; all resolved platforms remain pinned in package-lock.json.`,
);
