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
 * One user harness message as the wire carries it: a plain string when it
 * has no image blocks, or an OpenAI content-parts array (text part plus one
 * `image_url` data-URL part per image) when `resolveImage` can project the
 * blocks. Offloaded image occurrences arrive already replaced with
 * placeholder text by the harness, so only live blocks reach here; an image
 * that `resolveImage` rejects degrades the message to text rather than
 * failing the request.
 * @param {string | Array<object>} content harness user content
 * @param {(block: object) => Promise<object | undefined>} [resolveImage]
 *   projects one harness image block onto a wire content part
 * @returns {Promise<string | Array<object>>} wire content
 */
async function userContent(content, resolveImage) {
	if (typeof content === 'string') return content;
	const text = blocksText(content);
	const images = (content ?? []).filter((block) => block.type === 'image' && block.offloaded !== true);
	if (images.length === 0 || resolveImage === undefined) return text;
	const parts = [];
	if (text.length > 0) parts.push({ type: 'text', text });
	for (const block of images) {
		const part = await resolveImage(block);
		if (part !== undefined) parts.push(part);
	}
	return parts.length > 0 ? parts : text;
}

/**
 * Translate harness messages into OpenAI chat-completions messages.
 *
 * System and developer prompts collapse into one leading `system` message.
 * Tool results map to the `tool` role with the call id they answer. A user
 * message carrying images becomes the OpenAI multimodal part array when
 * `resolveImage` is supplied; without it, every message flattens to the
 * plain string form the route always sent.
 * @param {Array<object>} messages harness request messages
 * @param {(block: object) => Promise<object | undefined>} [resolveImage]
 *   image-block projection; absent means images cannot be sent
 * @returns {Promise<Array<object>>} wire messages
 */
export async function toWireMessages(messages, resolveImage) {
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
				wire.push({ role: 'user', content: await userContent(message.content, resolveImage) });
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
