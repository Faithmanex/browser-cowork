// Skill registry: discovery, frontmatter rules, and the read API.
//
//   node test/verify-skills.mjs
import assert from 'node:assert/strict';
import { listSkills, skillIndex, readSkill } from '../server/skills.js';

let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

ok('discovers the feather skill with its description', () => {
  const skills = listSkills();
  const feather = skills.find((s) => s.name === 'feather-bet-setup');
  assert.ok(feather, `got ${JSON.stringify(skills)}`);
  assert.match(feather.description, /Feather/i);
  assert.ok(feather.description.length <= 1024);
});

ok('the index advertises name and description, not the body', () => {
  const index = skillIndex();
  assert.match(index, /feather-bet-setup:/);
  // The body's first rule must not leak into the prompt.
  assert.doesNotMatch(index, /four steps|The four steps/i);
});

ok('SKILL.md body is returned without frontmatter', () => {
  const body = readSkill('feather-bet-setup');
  assert.equal(body.ok, true);
  assert.match(body.text, /Feather: operating manual/);
  assert.doesNotMatch(body.text, /^---/);
});

ok('a listed reference can be read', () => {
  const ref = readSkill('feather-bet-setup', 'references/app.md');
  assert.equal(ref.ok, true);
  assert.equal(ref.file, 'references/app.md');
  assert.match(ref.text, /control deck/i);
});

ok('unlisted files are refused, with the available list', () => {
  const bad = readSkill('feather-bet-setup', '../../server/.env');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown file/i);
  assert.match(bad.error, /references\/app\.md/);

  const missing = readSkill('feather-bet-setup', 'references/nope.md');
  assert.equal(missing.ok, false);
});

ok('unknown skills and bad names are refused', () => {
  assert.equal(readSkill('does-not-exist').ok, false);
  assert.equal(readSkill('../etc').ok, false);
  assert.equal(readSkill('').ok, false);
});

console.log(`\n${checks} checks passed`);
