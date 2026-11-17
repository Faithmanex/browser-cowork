// History must be well-formed before a follow-up instruction is appended.
//
// The bug: a run stops at the step limit *after* the assistant message carrying
// a tool call is recorded but *before* its tool result. The next request is then
// rejected by the provider: "an assistant message with tool_calls must be
// followed by tool messages". closeDanglingCall repairs that.
//
//   node test/verify-continuation.mjs
import assert from 'node:assert/strict';
import {
  createConversation,
  getConversation,
  dropConversation,
  closeDanglingCall,
} from '../server/agent.js';

let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

ok('an unanswered tool call gets a matching tool result', () => {
  const id = createConversation('feather');
  const convo = getConversation(id);

  convo.events.push({ kind: 'user', text: 'setup 4 games on the vector account' });
  convo.events.push({
    kind: 'assistant',
    text: '',
    callId: 'call_1',
    callName: 'click_element',
    callArgs: '{"ref":"e1"}',
  });
  // This is what the step-limit path used to leave behind.
  convo.pendingCallId = null;
  convo.pendingAction = null;

  assert.equal(closeDanglingCall(convo), true);

  const last = convo.events.at(-1);
  assert.equal(last.kind, 'tool');
  assert.equal(last.callId, 'call_1');
  assert.equal(last.result.ok, false);
  assert.match(last.result.error, /no result was recorded/i);

  dropConversation(id);
});

ok('repairing twice is a no-op', () => {
  const id = createConversation('chrome');
  const convo = getConversation(id);
  convo.events.push({ kind: 'assistant', text: '', callId: 'call_2', callName: 'type_text' });

  assert.equal(closeDanglingCall(convo), true);
  assert.equal(closeDanglingCall(convo), false);
  assert.equal(convo.events.filter((e) => e.kind === 'tool').length, 1);

  dropConversation(id);
});

ok('an already answered call is left alone', () => {
  const id = createConversation('chrome');
  const convo = getConversation(id);
  convo.events.push({ kind: 'assistant', text: '', callId: 'call_3', callName: 'click_element' });
  convo.events.push({ kind: 'tool', callId: 'call_3', result: { ok: true } });

  assert.equal(closeDanglingCall(convo), false);
  assert.equal(convo.events.length, 2);

  dropConversation(id);
});

ok('a text-only conversation needs no repair', () => {
  const id = createConversation('chrome');
  const convo = getConversation(id);
  convo.events.push({ kind: 'user', text: 'hello' });
  convo.events.push({ kind: 'assistant', text: 'hi' });

  assert.equal(closeDanglingCall(convo), false);
  dropConversation(id);
});

console.log(`\n${checks} checks passed`);
