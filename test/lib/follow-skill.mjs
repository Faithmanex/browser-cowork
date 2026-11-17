// Allow for the skill hop in tests that judge the first action.
//
// With progressive disclosure the model loads the skill before acting, which is
// the mechanism working as intended. A test that inspects only the very first
// action would then fail on correct behaviour. Follow the hop, then judge.
export async function followSkill(base, headers, reply, observation, { hops = 2 } = {}) {
  let current = reply;

  for (let i = 0; i < hops; i += 1) {
    const name = current.action?.name;
    if (name !== 'use_skill' && name !== 'read_skill') break;

    const args = current.action.args || {};
    const skill = await fetch(`${base}/api/skill`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: args.name, file: name === 'read_skill' ? args.file || '' : '' }),
    }).then((r) => r.json());

    current = await fetch(`${base}/api/step`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversationId: current.conversationId,
        actionResult: skill,
        observation,
      }),
    }).then((r) => r.json());
  }

  return current;
}
