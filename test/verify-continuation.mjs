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

// The shape that actually bricked the conversation: two runs interleaved, so a
// call sat before a user message and its result arrived later. Repairing only
// the last call could never fix this.
ok('an out-of-order call is repaired in place', () => {
  const id = createConversation('feather');
  const convo = getConversation(id);
  convo.events.push({ kind: 'user', text: 'set up a game' });
  convo.events.push({ kind: 'assistant', text: '', callId: 'call_a', callName: 'click_element' });
  convo.events.push({ kind: 'user', text: 'zoom out to 0.4' });
  convo.events.push({ kind: 'assistant', text: '', callId: 'call_b', callName: 'set_zoom' });
  convo.events.push({ kind: 'tool', callId: 'call_b', name: 'set_zoom', result: { ok: true } });

  assert.equal(closeDanglingCall(convo), true);

  // Every assistant call must be immediately followed by its own result.
  convo.events.forEach((ev, i) => {
    if (ev.kind !== 'assistant' || !ev.callId) return;
    const next = convo.events[i + 1];
    assert.equal(next?.kind, 'tool', `call ${ev.callId} is not followed by a tool message`);
    assert.equal(next.callId, ev.callId);
  });

  assert.equal(convo.events.filter((e) => e.kind === 'tool').length, 2);
  dropConversation(id);
});

ok('a result with no matching call is dropped', () => {
  const id = createConversation('chrome');
  const convo = getConversation(id);
  convo.events.push({ kind: 'user', text: 'go' });
  convo.events.push({ kind: 'tool', callId: 'call_ghost', result: { ok: true } });
  convo.events.push({ kind: 'assistant', text: 'done' });

  assert.equal(closeDanglingCall(convo), true);
  assert.equal(convo.events.length, 2);
  assert.equal(convo.events[1].kind, 'assistant');
  dropConversation(id);
});

console.log(`\n${checks} checks passed`);
