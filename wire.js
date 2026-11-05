/**
 * OpenAI-compatible wire helpers: harness-message translation and SSE parsing.
 *
 * llama-swap fronts vLLM, so the request shape is plain chat completions:
 * `system`/`user`/`assistant`/`tool` messages, `tool_calls` on assistant
 * turns, and `tool_call_id` on tool results. Assistant reasoning is dropped
 * from replay — the OpenAI shape has no field for it, and vLLM's chat
 * template re-derives thinking from the prompt rather than the history.
 *
 * @module wire
 */

/** Flatten harness content blocks into the wire's string content form. */
function blocksText(blocks) {
	if (typeof blocks === 'string') return blocks;
	const parts = [];
	for (const block of blocks ?? []) {
		if (block.type === 'text') parts.push(block.text);
	}
	return parts.join('');
}

/** One assistant harness message as the wire carries it. */
function assistantWire(message) {
	const texts = [];
	const toolCalls = [];
	for (const block of message.content ?? []) {
		if (block.type === 'text') texts.push(block.text);
		else if (block.type === 'tool-call') {
			toolCalls.push({
				id: block.id,
				type: 'function',
				function: { name: block.name, arguments: block.arguments },
			});
		}
	}
	const text = texts.join('');
	/** @type {{ role: string, content: string | null, tool_calls?: Array<object> }} */
	const wire = { role: 'assistant', content: text.length > 0 ? text : null };
	if (toolCalls.length > 0) wire.tool_calls = toolCalls;
	return wire;
}

/**
 * Translate harness messages into OpenAI chat-completions messages.
 *
 * System and developer prompts collapse into one leading `system` message.
 * Tool results map to the `tool` role with the call id they answer.
 * @param {Array<object>} messages harness request messages
 * @returns {Array<object>} wire messages
 */
export function toWireMessages(messages) {
	const wire = [];
	const systemTexts = [];
	for (const message of messages) {
		switch (message.role) {
			case 'system':
			case 'developer': {
				systemTexts.push(blocksText(message.content));
				break;
			}
			case 'user': {
				wire.push({ role: 'user', content: blocksText(message.content) });
				break;
			}
			case 'assistant': {
				wire.push(assistantWire(message));
				break;
			}
			case 'tool': {
				wire.push({ role: 'tool', content: blocksText(message.content), tool_call_id: message.toolCallId });
				break;
			}
			default: {
				wire.push({ role: message.role, content: blocksText(message.content) });
				break;
			}
		}
	}
	const system = systemTexts.filter((text) => text.length > 0).join('\n\n');
	if (system.length > 0) wire.unshift({ role: 'system', content: system });
	return wire;
}

/**
 * Parse one SSE byte line into a JSON payload, or null between events.
 * @param {string} line
 * @returns {object | null}
 */
export function sseDataLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return null;
	const payload = trimmed.slice(5).trim();
	if (payload.length === 0 || payload === '[DONE]') return null;
	try {
		return JSON.parse(payload);
	} catch {
		return null;
	}
}
