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

export const Config = z.object({
	/** Environment-variable name the llama-swap API key is stored under. */
	apiKeyEnv: z.string().role('credential-ref').default('LOCAL_API_KEY'),
	/** llama-swap's OpenAI base URL (the `/v1` suffix included). */
	baseURL: z.string().default('http://ponga.ts.fedesito.me:8080/v1'),
	/** How long a fetched catalog answers follow-up lookups, in ms. */
	catalogTTLms: z.number().min(1000).default(60_000),
});

/**
 * Wire the provider into the running harness.
 * @param {object} ctx the cordis context the plugin activates in
 * @param {object} config the resolved plugin config
 */
export function apply(ctx, config) {
	const apiKeyEnv = config.apiKeyEnv ?? 'LOCAL_API_KEY';
	const baseURL = (config.baseURL ?? 'http://ponga.ts.fedesito.me:8080/v1').replace(/\/+$/, '');

	/** Resolve the route's key from the credential seam, then ambient env. */
	const resolveApiKey = async () => {
		const credentials = ctx.get('credentials');
		if (credentials !== undefined) {
			const resolved = await credentials.resolve(credentialRef(apiKeyEnv));
			if (resolved?.value !== undefined) {
				return assertUsableApiKey(resolved.value, 'dsh-llama-swap', apiKeyEnv);
			}
		}
		const ambient = process.env[apiKeyEnv];
		return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
	};

	const adapter = new LlamaSwapAdapter({
		resolveApiKey,
		baseURL,
		catalogTTLms: config.catalogTTLms ?? 60_000,
		debug: (message) => ctx.logger.debug(message),
	});

	ctx.llm.registerAdapter([PROVIDER_ID], adapter);
	ctx.llm.registerConfigurableProviders([
		{
			provider: PROVIDER_ID,
			displayName: 'llama-swap',
			settingsNs: 'llama-swap',
			settingsPath: [],
			declared: false,
			defaultBaseURL: baseURL,
			nativeAuth: { env: [apiKeyEnv] },
		},
	]);

	ctx.logger.info(`llama-swap: provider registered (${baseURL}, key ${apiKeyEnv})`);
}
