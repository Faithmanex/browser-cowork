// Two provider adapters behind one interface. Swapping providers must never
// require touching browser-control code, so everything provider-specific stops
// at this file's boundary.

const toGeminiTools = (tools) =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
  }));

const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));

/**
 * Gemini wants the model's own parts echoed back verbatim (thought signatures
 * and function-call metadata live there), and every function response of one
 * assistant turn inside a single user turn.
 */
function toGeminiContents(events) {
  const contents = [];

  for (const ev of events) {
    if (ev.kind === 'user') {
      const parts = [{ text: ev.text }];
      if (ev.image?.data) {
        parts.push({ inlineData: { mimeType: ev.image.mime || 'image/jpeg', data: ev.image.data } });
      }
      contents.push({ role: 'user', parts, _fn: false });
    } else if (ev.kind === 'assistant') {
      const parts = ev.rawParts && ev.rawParts.length ? ev.rawParts : [{ text: ev.text || '' }];
      contents.push({ role: 'model', parts, _fn: false });
    } else if (ev.kind === 'tool') {
      const part = { functionResponse: { name: ev.name, response: { result: ev.result } } };
      const last = contents[contents.length - 1];
      if (last && last._fn) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part], _fn: true });
    }
  }

  return contents.map(({ role, parts }) => ({ role, parts }));
}

function toOpenAIMessages(system, events, includeReasoning) {
  const messages = [{ role: 'system', content: system }];

  for (const ev of events) {
    if (ev.kind === 'user') {
      if (ev.image?.data) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: ev.text },
            {
              type: 'image_url',
              image_url: { url: `data:${ev.image.mime || 'image/jpeg'};base64,${ev.image.data}` },
            },
          ],
        });
      } else {
        messages.push({ role: 'user', content: ev.text });
      }
    } else if (ev.kind === 'assistant') {
      const msg = { role: 'assistant', content: ev.text || null };
      if (ev.callName) {
        msg.tool_calls = [
          {
            id: ev.callId,
            type: 'function',
            function: { name: ev.callName, arguments: ev.callArgs || '{}' },
          },
        ];
      }
      // DeepSeek: with `tools` present, prior chain-of-thought must be echoed
      // back or the next request is rejected.
      if (includeReasoning && typeof ev.reasoning === 'string') {
        msg.reasoning_content = ev.reasoning;
      }
      messages.push(msg);
    } else if (ev.kind === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: ev.callId,
        content: JSON.stringify(ev.result),
      });
    }
  }

  return messages;
}

async function callGemini(cfg, { system, events, tools }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cfg.model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(events),
      tools: [{ functionDeclarations: toGeminiTools(tools) }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 4096 },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini returned ${res.status}`);

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  // `thought` parts are reasoning and are echoed back but never shown.
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();

  const callPart = parts.find((p) => p.functionCall);
  const call = callPart
    ? {
        name: callPart.functionCall.name,
        args: callPart.functionCall.args || {},
      }
    : null;

  if (!text && !call) {
    const reason =
      candidate?.finishReason || data?.promptFeedback?.blockReason || 'no content returned';
    throw new Error(`Gemini returned nothing usable (${reason}).`);
  }

  return { text, call, rawParts: parts };
}

async function callOpenAI(cfg, { system, events, tools }) {
  const root = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const body = {
    model: cfg.model,
    messages: toOpenAIMessages(system, events, cfg.provider === 'deepseek'),
    tools: toOpenAITools(tools),
    tool_choice: 'auto',
    ...(cfg.extras || {}),
  };

  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Provider returned ${res.status}`);

  const msg = data.choices?.[0]?.message || {};
  const text = String(msg.content || '').trim();
  const toolCall = (msg.tool_calls || [])[0];

  let call = null;
  if (toolCall) {
    let args = {};
    try {
      args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      args = {};
    }
    call = {
      name: toolCall.function?.name,
      args,
      id: toolCall.id,
      rawArgs: toolCall.function?.arguments,
    };
  }

  if (!text && !call) throw new Error('The model returned no content and no action.');

  return { text, call, rawParts: null, reasoning: msg.reasoning_content || '' };
}

/**
 * A model without vision must still see *that* the user attached an image, and
 * must be told it cannot look at it, or it will confidently invent contents.
 */
function withoutImages(request) {
  return {
    ...request,
    events: request.events.map((ev) =>
      ev.image && ev.text !== undefined
        ? {
            ...ev,
            image: undefined,
            text: `${ev.text}\n\n(An image was attached here, but ${ev.image.mime || 'image'} input is not supported by the configured model. Work from the element list.)`,
          }
        : ev,
    ),
  };
}

/**
 * @param {{provider: string, adapter: string, apiKey: string, model: string, baseUrl?: string, vision?: boolean}} cfg
 * @param {{system: string, events: Array<object>, tools: Array<object>}} request
 */
export async function complete(cfg, request) {
  if (!cfg.apiKey) {
    throw new Error(
      `No API key configured for provider "${cfg.provider}". Add one to server/.env and restart.`,
    );
  }

  const payload = cfg.vision === false ? withoutImages(request) : request;
  return cfg.adapter === 'openai' ? callOpenAI(cfg, payload) : callGemini(cfg, payload);
}
