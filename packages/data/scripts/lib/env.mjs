import fs from 'node:fs/promises';
import path from 'node:path';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isValidKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function unescapeDoubleQuoted(value) {
  // Minimal escapes: keep it conservative.
  return value
    .replaceAll('\\\\n', '\n')
    .replaceAll('\\\\r', '\r')
    .replaceAll('\\\\t', '\t')
    .replaceAll('\\\\\"', '"')
    .replaceAll('\\\\\\\\', '\\');
}

function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trim();
    if (!isValidKey(key)) continue;

    let value = stripped.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = unescapeDoubleQuoted(value.slice(1, -1));
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

export async function loadDotenv({ repoRoot, filenames = ['.env', '.env.local'] } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  /** Keys we set from dotenv files (so later files can override earlier file values). */
  const setByThis = new Set();

  for (const name of filenames) {
    const abs = path.join(repoRoot, name);
    if (!(await fileExists(abs))) continue;

    const raw = await fs.readFile(abs, 'utf8');
    const parsed = parseDotenv(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined || setByThis.has(k)) {
        process.env[k] = v;
        setByThis.add(k);
      }
    }
  }

  return { keysSet: [...setByThis] };
}

