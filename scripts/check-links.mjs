import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', 'temporary screenshots']);
const htmlFiles = walk(ROOT).filter(file => file.endsWith('.html'));
const problems = [];

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /\b(?:href|src)=["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    if (!raw || shouldSkip(raw)) continue;

    const [withoutHash, hash = ''] = raw.split('#');
    const [withoutQuery] = withoutHash.split('?');
    if (!withoutQuery && hash) {
      checkAnchor(file, file, hash);
      continue;
    }

    const resolved = resolveLocal(file, withoutQuery);
    if (!resolved) continue;
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel(file)} -> missing ${raw}`);
      continue;
    }
    if (hash && resolved.endsWith('.html')) checkAnchor(file, resolved, hash);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`Local link check passed (${htmlFiles.length} HTML files).`);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : walk(full);
    }
    return [full];
  });
}

function shouldSkip(value) {
  return /^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(value)
    || value.startsWith('{{')
    || value.startsWith('about:');
}

function resolveLocal(fromFile, value) {
  const decoded = safeDecode(value);
  let target = decoded.startsWith('/')
    ? path.join(ROOT, decoded)
    : path.join(path.dirname(fromFile), decoded);
  target = path.normalize(target);
  if (!target.startsWith(ROOT)) return null;
  if (target.endsWith(path.sep)) target = path.join(target, 'index.html');
  return target;
}

function checkAnchor(fromFile, targetFile, hash) {
  const id = safeDecode(hash);
  if (!id || id === 'top') return;
  const targetHtml = fs.readFileSync(targetFile, 'utf8');
  const escaped = escapeRegExp(id);
  const hasAnchor = new RegExp(`(?:id|name)=["']${escaped}["']`).test(targetHtml);
  if (!hasAnchor) problems.push(`${rel(fromFile)} -> missing anchor #${id} in ${rel(targetFile)}`);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rel(file) {
  return path.relative(ROOT, file);
}
