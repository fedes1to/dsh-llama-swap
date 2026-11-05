/**
 * dsh-llama-swap — a llama-swap provider whose model catalog is whatever the
 * server advertises at `GET {baseURL}/models`, not a hand-maintained list.
 *
 * llama-swap already publishes everything the model picker needs per entry:
 * `name`, `description`, `context_length`, `capabilities.function_calling`,
 * and — the reason this plugin exists — `meta.llamaswap.reasoning.efforts`
 * (plus `default` and `toggle`). Adding a model to config.d therefore makes
 * its reasoning efforts appear in the TUI with no client-side edit.
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
 * The llama-swap provider: live catalog, OpenAI-compatible streaming.
 */
export class LlamaSwapAdapter extends LlmAdapter {
	/**
	 * @param {object} options
	 * @param {() => Promise<string | undefined>} options.resolveApiKey credential resolution for the route
	 * @param {string} options.baseURL llama-swap OpenAI base, e.g. http://host:8080/v1
	 * @param {number} [options.catalogTTLms] catalog cache lifetime
	 * @param {(message: string) => void} [options.debug] diagnostic sink
	 */
	constructor({ resolveApiKey, baseURL, catalogTTLms = DEFAULT_TTL_MS, debug } = {}) {
		super();
		this.resolveApiKey = resolveApiKey;
		this.baseURL = String(baseURL ?? '').replace(/\/+$/, '');
		this.catalogTTLms = catalogTTLms;
		this.debug = debug ?? (() => {});
		/** @type {{ at: number, models: Array<object> } | undefined} */
		this.catalogCache;
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
			...(reasoning !== undefined ? { reasoning } : {}),
		};
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
				'no llama-swap credential: store LOCAL_API_KEY or set the plugin\'s apiKeyEnv',
				'MISSING_CREDENTIAL',
			);
		}
		const entry = await this.entryFor(options.model);
		const supportsReasoning = (entry?.efforts?.length ?? 0) > 0;
		const effort = options.reasoningEffort;
		const thinking = supportsReasoning && effort !== OFF_EFFORT;

		const body = {
			model: options.model,
			messages: toWireMessages(options.messages),
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
