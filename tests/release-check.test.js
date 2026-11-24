const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {versionFromTag, changelogSection, check} = require('../scripts/release-check.cjs');

test('release tags must be v-prefixed semver', () => {
  assert.equal(versionFromTag('v1.2.3'), '1.2.3');
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-beta', '', undefined]) assert.throws(() => versionFromTag(bad));
});

test('changelog section stops at the next version heading and does not match prefixes', () => {
  const text = '# Changelog\n\n## 未发布\n\n## 1.0.10（2026-12-01）\n\n- ten\n\n## 1.0.1（2026-11-30）\n\n### 任务\n\n- one\n\n## 1.0.0\n\n- zero\n';
  assert.deepEqual(changelogSection(text, '1.0.1'), {heading: '1.0.1（2026-11-30）', body: '### 任务\n\n- one'});
  assert.equal(changelogSection(text, '1.0.0').body, '- zero');
  assert.equal(changelogSection(text, '1.0.2'), null);
});

function fixture({manifest = '1.0.1', pkg = '1.0.1', lock = '1.0.1', changelog = '## 1.0.1（2026-11-30）\n\n- one\n'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  fs.mkdirSync(path.join(root, 'extension'));
  fs.writeFileSync(path.join(root, 'extension/manifest.json'), JSON.stringify({version: manifest}));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: pkg}));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({version: lock, packages: {'': {version: lock}}}));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  return root;
}

test('release check passes only when every version and the changelog agree', () => {
  assert.deepEqual(check(fixture(), 'v1.0.1').errors, []);
  assert.match(check(fixture({manifest: '1.0.0'}), 'v1.0.1').errors.join('\n'), /manifest\.json version is 1\.0\.0/);
  assert.match(check(fixture({lock: '1.0.0'}), 'v1.0.1').errors.join('\n'), /package-lock\.json/);
  assert.match(check(fixture({changelog: '## 未发布\n\n- one\n'}), 'v1.0.1').errors.join('\n'), /no "## 1\.0\.1" section/);
  assert.match(check(fixture({changelog: '## 1.0.1\n\n## 1.0.0\n\n- x\n'}), 'v1.0.1').errors.join('\n'), /is empty/);
});

test('repository itself is consistent with its current version', () => {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'))).version;
  assert.deepEqual(check(root, `v${version}`).errors.filter(e => !e.includes('CHANGELOG')), []);
});
