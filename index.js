/**
 * dsh-llama-swap — llama-swap as a dsh provider, with the model catalog and
 * per-model reasoning efforts read live from `GET {baseURL}/models`.
 *
 * Why: llama-swap already publishes `meta.llamaswap.reasoning.efforts` (and
 * `default`, `context_length`, `capabilities.function_calling`) for every
 * entry in config.d. A hand-maintained `models:` list in the profile's
 * `llm-pi-ai` row duplicates that and silently goes stale — a new model shows
 * no reasoning efforts until someone edits the YAML. This adapter reads the
 * server instead, so adding a model to llama-swap is the whole workflow.
 *
 * @module index
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { LlamaSwapAdapter, PROVIDER_ID } from './adapter.js';

export const name = 'llama-swap';

/**
 * `llm` and `credentials` are mounted by the dsh-tui composition. Without the
 * inject list cordis withholds them and `ctx.llm` throws before activation.
 */
export const inject = ['llm', 'credentials'];

/**
 * No deployment values live in this schema: the endpoint and the credential
 * name are supplied by the profile's config (or the environment), so the same
 * package works against any llama-swap. `127.0.0.1:8080` is llama-swap's own
 * default listen address, used only when neither is set.
 */
export const Config = z.object({
	/**
	 * Environment-variable name the llama-swap API key is stored under.
	 * Volatile so the Settings page can retarget the credential without a
	 * restart; the adapter resolves it on every request.
	 */
	apiKeyEnv: z.string().role('credential-ref').volatile(),
	/**
	 * llama-swap's OpenAI base URL (the `/v1` suffix included). Volatile so
	 * the Settings page's save takes effect on the next request.
	 */
	baseURL: z.string().volatile(),
	/** How long a fetched catalog answers follow-up lookups, in ms. */
	catalogTTLms: z.number().min(1000).default(60_000).volatile(),
});

/** llama-swap's default listen address, used only when nothing else says. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/** The credential name used only when the profile names none. */
const DEFAULT_API_KEY_ENV = 'LLAMA_SWAP_API_KEY';

/**
 * Resolve the endpoint: profile config, then `LLAMA_SWAP_BASE_URL`, then
 * llama-swap's own default listen address.
 * @param {object} config plugin config
 * @param {NodeJS.ProcessEnv} env process environment
 */
/**
 * Read one config field, following a volatile reference when the settings
 * service wrapped it. A plain value (tests, a host without settings) passes
 * through.
 * @param {unknown} value field value or volatile reference
 */
export function readConfig(value) {
	return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

export function resolveBaseURL(config, env) {
	const configured = readConfig(config.baseURL) ?? env.LLAMA_SWAP_BASE_URL ?? DEFAULT_BASE_URL;
	return String(configured).replace(/\/+$/, '');
}

/**
 * Resolve the credential reference: profile config, then
 * `LLAMA_SWAP_API_KEY_ENV`, then a plugin-named default.
 * @param {object} config plugin config
 * @param {NodeJS.ProcessEnv} env process environment
 */
export function resolveApiKeyEnv(config, env) {
	return readConfig(config.apiKeyEnv) ?? env.LLAMA_SWAP_API_KEY_ENV ?? DEFAULT_API_KEY_ENV;
}

/**
 * Wire the provider into the running harness.
 * @param {object} ctx the cordis context the plugin activates in
 * @param {object} config the resolved plugin config
 */
export function apply(ctx, config) {
	// Resolved per call, not once at activation: a Settings save updates the
	// volatile reference, and the next catalog fetch or completion must see
	// it. The registration log records the value at activation only.
	const apiKeyEnv = () => resolveApiKeyEnv(config, process.env);
	const baseURL = () => resolveBaseURL(config, process.env);

	/** Resolve the route's key from the credential seam, then ambient env. */
	const resolveApiKey = async () => {
		const envName = apiKeyEnv();
		const credentials = ctx.get('credentials');
		if (credentials !== undefined) {
			const resolved = await credentials.resolve(credentialRef(envName));
			if (resolved?.value !== undefined) {
				return assertUsableApiKey(resolved.value, 'dsh-llama-swap', envName);
			}
		}
		const ambient = process.env[envName];
		return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
	};

	const adapter = new LlamaSwapAdapter({
		resolveApiKey,
		baseURL,
		catalogTTLms: () => {
			const configured = readConfig(config.catalogTTLms);
			return typeof configured === 'number' ? configured : 60_000;
		},
		debug: (message) => ctx.logger.debug(message),
		// The durable attachment store is what turns an image block into
		// request bytes. Read softly like the footer: a headless
		// composition without it still activates, and image requests fail
		// with a clear UNSUPPORTED_CONTENT instead of silently dropping
		// the picture.
		attachments: ctx.get('attachments', false) ?? undefined,
	});

	ctx.llm.registerAdapter([PROVIDER_ID], adapter);
	// The settings namespace is the profile row's own id, not a literal: a
	// deployment that mounts this plugin under another id keeps one address
	// for its settings page and its configurable-provider directory entry.
	const settingsNs = ctx.fiber?.entry?.options?.id ?? 'llama-swap';
	ctx.llm.registerConfigurableProviders([
		{
			provider: PROVIDER_ID,
			displayName: 'llama-swap',
			settingsNs,
			settingsPath: [],
			declared: false,
			defaultBaseURL: baseURL(),
			nativeAuth: { env: [apiKeyEnv()] },
		},
	]);

	ctx.logger.info(`llama-swap: provider registered (${baseURL()}, key ${apiKeyEnv()})`);
}
