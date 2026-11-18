/**
 * dsh-llama-swap — a llama-swap provider whose model catalog is whatever the
 * server advertises at `GET {baseURL}/models`, not a hand-maintained list.
 *
 * llama-swap already publishes everything the model picker needs per entry:
 * `name`, `description`, `context_length`, `capabilities.function_calling`,
 * the input modalities (`architecture.input_modalities`, mirrored as the
 * `vision` capability), and — the reason this plugin exists —
 * `meta.llamaswap.reasoning.efforts` (plus `default` and `toggle`). Adding
 * a model to config.d therefore makes its reasoning efforts appear in the
 * TUI with no client-side edit; declaring `in: [text, image]` there is what
 * makes image reads work on it.
 *
 * The wire is OpenAI-compatible chat completions: vLLM behind llama-swap
 * streams `delta.content`, `delta.reasoning_content` (the qwen3 reasoning
 * parser) and OpenAI-shaped `tool_calls` fragments. Thinking is switched with
 * `chat_template_kwargs.enable_thinking`, matching the profile's previous
 * `llm-pi-ai` compat block, and the selected effort rides as
 * `reasoning_effort`.
 *
 * @module adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { sseDataLine, toWireMessages } from './wire.js';

/** The route key this adapter registers under. */
export const PROVIDER_ID = 'llama-swap';

/** Effort id that means "do not think" — mapped to `enable_thinking: false`. */
export const OFF_EFFORT = 'off';

/** How long a fetched catalog answers follow-up lookups before a refetch. */
const DEFAULT_TTL_MS = 60_000;

/** How long the catalog fetch may take before it counts as failed. */
const CATALOG_TIMEOUT_MS = 5_000;

/** Capitalize an effort id for display. */
function effortName(id) {
	return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Whether any message in a request carries a non-offloaded image block.
 * Offloaded occurrences already arrived as placeholder text, so only live
 * blocks matter for the capability gate.
 * @param {Array<object>} messages harness request messages
 * @returns {boolean}
 */
function requestHasImage(messages) {
	return messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === 'image' && block.offloaded !== true),
	);
}

/** Map an OpenAI finish reason onto the harness vocabulary. */
function finishReason(native) {
	switch (native) {
		case 'length':
			return { kind: 'max-tokens' };
		case 'tool_calls':
			return { kind: 'tool-calls' };
		case 'error':
			return { kind: 'error', failure: { message: 'llama-swap aborted the generation', code: 'PROVIDER_ERROR' } };
		default:
			return { kind: 'stop' };
	}
}

/** Read a positive integer off a listing entry, or undefined. */
function capacity(...candidates) {
	for (const candidate of candidates) {
		if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

/** Read a non-empty string off a listing entry, or undefined. */
function label(...candidates) {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length > 0) return candidate;
	}
	return undefined;
}

/**
 * The input modalities the harness should believe for one catalog entry.
 * llama-swap publishes them in the OpenAI-shaped `architecture` block and
 * mirrors image input as `capabilities.vision`. Text is implicit; an entry
 * with neither signal gets no modality list at all, which the harness
 * treats as text-only.
 * @param {object} entry raw /v1/models listing entry
 * @returns {string[] | undefined} e.g. ['text', 'image']
 */
function inputModalities(entry) {
	const declared = Array.isArray(entry?.architecture?.input_modalities)
		? entry.architecture.input_modalities
		: [];
	const image = declared.includes('image') || entry?.capabilities?.vision === true;
	return image ? ['text', 'image'] : undefined;
}

/**
 * The llama-swap provider: live catalog, OpenAI-compatible streaming.
 */
export class LlamaSwapAdapter extends LlmAdapter {
	/**
	 * @param {object} options
	 * @param {() => Promise<string | undefined>} options.resolveApiKey credential resolution for the route
	 * @param {string} options.baseURL llama-swap OpenAI base, e.g. http://<host>:8080/v1
	 * @param {number} [options.catalogTTLms] catalog cache lifetime
	 * @param {(message: string) => void} [options.debug] diagnostic sink
	 * @param {object} [options.attachments] durable attachment store, needed to
	 *   turn image blocks into request bytes; absent leaves images unsendable
	 *   even when the catalog says the model takes them
	 */
	constructor({ resolveApiKey, baseURL, catalogTTLms = DEFAULT_TTL_MS, debug, attachments } = {}) {
		super();
		this.resolveApiKey = resolveApiKey;
		// A function is a live settings read: the Settings page writes a
		// volatile field, and the next catalog fetch or completion must use
		// it without a restart. A string is the value captured at
		// construction, which is what tests and headless callers pass.
		this.readBaseURL = typeof baseURL === 'function' ? baseURL : () => baseURL;
		this.readCatalogTTLms = typeof catalogTTLms === 'function' ? catalogTTLms : () => catalogTTLms;
		this.baseURL = this.normalizeBaseURL(this.readBaseURL());
		this.catalogTTLms = this.normalizeTTL(this.readCatalogTTLms());
		this.debug = debug ?? (() => {});
		this.attachments = attachments;
		/** @type {{ at: number, models: Array<object> } | undefined} */
		this.catalogCache;
	}

	/** Drop a trailing slash so `${baseURL}/models` never doubles it. */
	normalizeBaseURL(baseURL) {
		return String(baseURL ?? '').replace(/\/+$/, '');
	}

	/** A non-positive TTL would refetch on every lookup; keep the last good one. */
	normalizeTTL(catalogTTLms) {
		return typeof catalogTTLms === 'number' && catalogTTLms >= 1000 ? catalogTTLms : DEFAULT_TTL_MS;
	}

	/**
	 * Pick up a settings write. A changed endpoint or TTL drops the cached
	 * catalog, so the picker does not keep serving the previous server's
	 * models for the remainder of the old TTL.
	 */
	refreshEndpoint() {
		const baseURL = this.normalizeBaseURL(this.readBaseURL());
		const catalogTTLms = this.normalizeTTL(this.readCatalogTTLms());
		if (baseURL !== this.baseURL || catalogTTLms !== this.catalogTTLms) {
			this.catalogCache = undefined;
		}
		this.baseURL = baseURL;
		this.catalogTTLms = catalogTTLms;
	}

	providerInfo(provider) {
		return { id: provider, name: 'llama-swap' };
	}

	/**
	 * One catalog entry per model the server advertises, normalized. A failed
	 * fetch keeps the last good catalog (and returns [] on the very first
	 * failure) — a llama-swap restart must not empty the picker.
	 * @returns {Promise<Array<object>>} normalized entries
	 */
	async catalog() {
		this.refreshEndpoint();
		if (this.catalogCache !== undefined && Date.now() - this.catalogCache.at < this.catalogTTLms) {
			return this.catalogCache.models;
		}
		try {
			const apiKey = await this.resolveApiKey();
			const response = await fetch(`${this.baseURL}/models`, {
				headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`status ${response.status}`);
			const payload = await response.json();
			const listed = Array.isArray(payload?.data)
				? payload.data
				: Array.isArray(payload?.models)
					? payload.models
					: [];
			const models = [];
			for (const entry of listed) {
				const id = label(entry?.id);
				if (id === undefined) continue;
				const reasoning = entry?.meta?.llamaswap?.reasoning;
				const efforts = Array.isArray(reasoning?.efforts)
					? reasoning.efforts.filter((effort) => typeof effort === 'string' && effort.length > 0)
					: [];
				models.push({
					id,
					name: label(entry?.name, entry?.description) ?? id,
					description: label(entry?.description),
					contextWindow: capacity(entry?.context_length, entry?.context_window, entry?.meta?.n_ctx),
					efforts,
					defaultEffort: label(reasoning?.default),
					tools: entry?.capabilities?.function_calling === true,
					// llama-swap advertises input modalities in the OpenAI-shaped
					// `architecture` block and mirrors image input as the
					// `vision` capability. The harness gates image reads on
					// this list, so a vision model without it silently
					// degrades every read_image to a text-only placeholder.
					inputModalities: inputModalities(entry),
				});
			}
			if (models.length === 0) throw new Error('empty catalog');
			this.catalogCache = { at: Date.now(), models };
			return models;
		} catch (error) {
			this.debug(`llama-swap: model catalog fetch failed (${error?.message ?? error})`);
			return this.catalogCache?.models ?? [];
		}
	}

	/** One normalized entry, or undefined when the server no longer lists it. */
	async entryFor(model) {
		return (await this.catalog()).find((entry) => entry.id === model);
	}

	async listModels() {
		return (await this.catalog()).map((entry) => ({
			provider: PROVIDER_ID,
			id: entry.id,
			name: entry.name,
			...(entry.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
		}));
	}

	/**
	 * Everything llama-swap publishes about one model, including the reasoning
	 * efforts the picker shows. `off` is prepended whenever the server reports
	 * any effort: the harness has no separate thinking switch for a custom
	 * adapter, so "off" is how a caller asks for `enable_thinking: false`.
	 */
	async resolveModel(_provider, model) {
		const entry = await this.entryFor(model);
		const efforts = entry?.efforts ?? [];
		const reasoning = efforts.length > 0
			? {
				efforts: [
					{ id: OFF_EFFORT, name: 'Off' },
					...efforts.map((id) => ({ id, name: effortName(id) })),
				],
				...(entry?.defaultEffort !== undefined && efforts.includes(entry.defaultEffort)
					? { defaultEffort: entry.defaultEffort }
					: {}),
			}
			: undefined;
		return {
			provider: PROVIDER_ID,
			id: model,
			name: entry?.name ?? model,
			...(entry?.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {}),
			...(entry?.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
			...(reasoning !== undefined ? { reasoning } : {}),
		};
	}

	/**
	 * Project one harness image block onto the OpenAI `image_url` content
	 * part vLLM accepts: a data URL of the stored bytes. Offloaded
	 * occurrences never reach here — the wire layer represents those as
	 * text.
	 * @param {object} block harness image block
	 * @param {AbortSignal} [signal] request cancellation
	 * @returns {Promise<object | undefined>} wire content part, or undefined
	 *   when this route has no attachment store to read the image from
	 */
	async imagePart(block, signal) {
		if (this.attachments === undefined) return undefined;
		const stored = await this.attachments.readImage(block.attachment, signal);
		const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType ?? 'image/png';
		const base64 = Buffer.from(stored.data).toString('base64');
		return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } };
	}

	/**
	 * Stream one chat completion. Reasoning and text ride fixed block indexes
	 * (0 = reasoning, 1 = text); tool calls start at 2.
	 * @param {object} options generate options
	 * @returns {AsyncGenerator<object>}
	 */
	async *stream(options) {
		const apiKey = await this.resolveApiKey();
		if (apiKey === undefined || apiKey.length === 0) {
			throw new LlmError(
				'no llama-swap credential: store the credential named by the plugin\'s apiKeyEnv (or export it)',
				'MISSING_CREDENTIAL',
			);
		}
		const entry = await this.entryFor(options.model);
		const supportsReasoning = (entry?.efforts?.length ?? 0) > 0;
		const effort = options.reasoningEffort;
		const thinking = supportsReasoning && effort !== OFF_EFFORT;

		// A request carrying a live image block must go to a model the
		// catalog declares image-capable, through a route with the durable
		// attachment store. Failing loud beats silently dropping the
		// picture into a text-only wire.
		const hasImage = requestHasImage(options.messages);
		if (hasImage) {
			if (entry?.inputModalities?.includes('image') !== true) {
				throw new LlmError(
					`llama-swap model "${options.model}" does not declare image input`,
					'UNSUPPORTED_CONTENT',
				);
			}
			if (this.attachments === undefined) {
				throw new LlmError(
					'llama-swap image input requires the durable attachment service',
					'UNSUPPORTED_CONTENT',
				);
			}
		}

		const body = {
			model: options.model,
			messages: await toWireMessages(
				options.messages,
				hasImage ? (block) => this.imagePart(block, options.signal) : undefined,
			),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = options.tools.map((tool) => ({
				type: 'function',
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			}));
		}
		if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
		if (options.temperature !== undefined) body.temperature = options.temperature;
		if (supportsReasoning) {
			body.chat_template_kwargs = { enable_thinking: thinking };
			if (thinking && typeof effort === 'string' && effort !== OFF_EFFORT) body.reasoning_effort = effort;
		}

		const response = await fetch(`${this.baseURL}/chat/completions`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${apiKey}`,
				'content-type': 'application/json',
				accept: 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal: options.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new LlmError(
				`llama-swap chat completions failed: ${response.status} ${detail.slice(0, 200)}`,
				'PROVIDER_ERROR',
				{ status: response.status },
			);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let usage;
		let finish;
		const calls = new Map();
		let nextSlot = 0;
		const mergeValue = (current, fragment) => {
			if (current.length === 0 || fragment.startsWith(current)) return fragment;
			if (current.endsWith(fragment)) return current;
			return current + fragment;
		};

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const payload = sseDataLine(line);
				if (payload === null) continue;
				const choice = payload.choices?.[0];
				const delta = choice?.delta;
				if (delta !== undefined) {
					// vLLM's qwen3 reasoning parser uses reasoning_content; some
					// OpenAI-compatible servers spell it reasoning.
					const reasoning = delta.reasoning_content ?? delta.reasoning;
					if (typeof reasoning === 'string' && reasoning.length > 0) {
						yield { type: 'reasoning-delta', index: 0, text: reasoning };
					}
					if (typeof delta.content === 'string' && delta.content.length > 0) {
						yield { type: 'text-delta', index: 1, text: delta.content };
					}
					for (const call of delta.tool_calls ?? []) {
						const slot = typeof call.index === 'number' ? call.index : nextSlot++;
						const state = calls.get(slot) ?? { id: '', name: '' };
						calls.set(slot, state);
						if (typeof call.id === 'string' && call.id.length > 0) {
							state.id = mergeValue(state.id, call.id);
						}
						if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
							state.name = mergeValue(state.name, call.function.name);
						}
						yield {
							type: 'tool-call-delta',
							index: 2 + slot,
							id: state.id.length > 0 ? state.id : `tool_call_${slot}`,
							...(state.name.length > 0 ? { name: state.name } : {}),
							argumentsDelta: call.function?.arguments ?? '',
						};
					}
				}
				if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
					finish = finishReason(choice.finish_reason);
				}
				if (payload.usage !== undefined && payload.usage !== null) usage = payload.usage;
			}
		}

		if (usage !== undefined) {
			const prompt = usage.prompt_tokens ?? 0;
			const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, prompt);
			const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
			const normalized = {
				inputTokens: prompt - cached,
				outputTokens: usage.completion_tokens ?? 0,
				totalTokens: usage.total_tokens ?? prompt + (usage.completion_tokens ?? 0),
				...(cached > 0 ? { cacheReadTokens: cached } : {}),
				...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
			};
			yield { type: 'usage', usage: normalized };
		}
		yield { type: 'finish', reason: finish ?? { kind: 'stop' } };
	}
}
