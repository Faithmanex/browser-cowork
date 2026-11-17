// Skill registry.
//
// Implements the Agent Skills convention (agentskills.io):
//   skills/<name>/SKILL.md      YAML frontmatter (name, description) + body
//   skills/<name>/references/   optional detail, loaded on demand
//
// Discovery reads only the frontmatter: that is what the agent is told about.
// The body is loaded when the model asks for the skill, and a reference is
// loaded only when it asks for that file. Nothing is pasted into the prompt
// up front beyond the one-line index.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILLS_ROOT = join(HERE, 'skills');

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: match[2].trim() };
}

/** Every skill directory that has a valid SKILL.md. */
export function listSkills() {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!NAME_RE.test(name)) continue;

    let text;
    try {
      text = readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }

    const { meta } = parseFrontmatter(text);
    // The spec requires the frontmatter name to match its directory.
    if (meta.name !== name) continue;
    if (!meta.description || meta.description.length > 1024) continue;

    out.push({ name, description: meta.description });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The one-line-per-skill index a client puts in its system prompt. */
export function skillIndex() {
  const skills = listSkills();
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    'Available skills. Load one with use_skill before working in its area; load a reference with',
    'read_skill only when you need that detail.',
    ...lines,
  ].join('\n');
}

function referenceFiles(name) {
  try {
    return readdirSync(join(SKILLS_ROOT, name, 'references'))
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a skill body or one of its references.
 * @returns {{ok: true, name: string, file: string, text: string} | {ok: false, error: string}}
 */
export function readSkill(name, file) {
  if (!NAME_RE.test(String(name || ''))) return { ok: false, error: 'invalid skill name' };
  if (!listSkills().some((s) => s.name === name)) return { ok: false, error: `unknown skill ${name}` };

  const wanted = file && String(file).trim() ? String(file).trim() : 'SKILL.md';
  const allowed = ['SKILL.md', ...referenceFiles(name).map((f) => `references/${f}`)];
  if (!allowed.includes(wanted)) {
    return {
      ok: false,
      error: `unknown file ${wanted}. Available: ${allowed.join(', ')}`,
    };
  }

  const path = resolve(SKILLS_ROOT, name, wanted);
  // Defence in depth: the allow-list already prevents traversal.
  if (!path.startsWith(resolve(SKILLS_ROOT, name))) return { ok: false, error: 'invalid path' };

  try {
    if (!statSync(path).isFile()) return { ok: false, error: 'not a file' };
    const raw = readFileSync(path, 'utf8');
    const text = wanted === 'SKILL.md' ? parseFrontmatter(raw).body : raw.trim();
    return { ok: true, name, file: wanted, text };
  } catch {
    return { ok: false, error: 'could not read the file' };
  }
}

export const skillFileNames = (name) => ['SKILL.md', ...referenceFiles(name).map((f) => `references/${f}`)];
export { basename };
