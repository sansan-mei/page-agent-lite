// Check that a release tag matches the extension version and CHANGELOG, then print the release notes.
// Usage: node scripts/release-check.cjs v1.2.3 [--notes <file>]
const fs = require('node:fs');
const path = require('node:path');

function versionFromTag(tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag || '');
  if (!m) throw new Error(`Tag must look like v1.2.3, got "${tag}"`);
  return m[1];
}

// Return the CHANGELOG body under "## <version>" up to the next "## " heading, or null.
function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replace(/\./g, '\\.');
  const start = lines.findIndex(l => new RegExp(`^## ${escaped}(?=[\\s（(]|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { heading: lines[start].slice(3).trim(), body: lines.slice(start + 1, end).join('\n').trim() };
}

function check(root, tag) {
  const version = versionFromTag(tag);
  const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const errors = [];
  const found = {
    'extension/manifest.json': read('extension/manifest.json').version,
    'package.json': read('package.json').version,
    'package-lock.json': read('package-lock.json').version,
    'package-lock.json packages[""]': read('package-lock.json').packages?.['']?.version
  };
  for (const [file, v] of Object.entries(found)) if (v !== version) errors.push(`${file} version is ${v}, expected ${version}`);
  const section = changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!section) errors.push(`CHANGELOG.md has no "## ${version}" section; move 未发布 entries under it first`);
  else if (!section.body) errors.push(`CHANGELOG.md section "${section.heading}" is empty`);
  return { version, errors, section };
}

module.exports = { versionFromTag, changelogSection, check };

if (require.main === module) {
  const [tag, flag, notesFile] = process.argv.slice(2);
  let result;
  try { result = check(path.resolve(__dirname, '..'), tag); }
  catch (e) { console.error(e.message); process.exit(1); }
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exit(1); }
  if (flag === '--notes' && notesFile) {
    const notes = `## ${result.section.heading}\n\n${result.section.body}\n\n安装包为 \`extension/\` 原样压缩，可在 Chrome / Edge 开发者模式中解压加载。\n`;
    fs.writeFileSync(notesFile, notes);
  }
  console.log(`Release ${tag} OK: versions match, CHANGELOG section "${result.section.heading}"`);
}
