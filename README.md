# dsh-llama-swap

A [dsh](https://github.com/deepseek-harness) provider for
[llama-swap](https://github.com/mostlygeek/llama-swap) whose **model catalog
and reasoning efforts come from the server**, not from a hand-maintained list
in the profile.

llama-swap already publishes everything a model picker needs for every entry
in its `config.d`:

```json
{
  "id": "swift-1.5-dflash2-pth",
  "name": "Swift-1.5 Heretic (DFlash2, PTH_FA int8 KV)",
  "context_length": 262144,
  "capabilities": { "function_calling": true },
  "meta": {
    "llamaswap": {
      "reasoning": {
        "supported": true,
        "efforts": ["low", "medium", "xhigh"],
        "default": "xhigh",
        "toggle": "chat_template_kwargs.enable_thinking",
        "budget_field": "thinking_token_budget"
      }
    }
  }
}
```

The stock `llm-pi-ai` route needs a `models:` entry per model with a
`reasoningEfforts` map, so a newly added llama-swap model shows **no available
reasoning efforts** until someone edits YAML. This plugin drops that
duplication: add the model to llama-swap, restart, done.

## Install

```bash
cd ~/.dsh/profiles/dsh-tui
# package.json: add "dsh-llama-swap": "link:/path/to/dsh-llama-swap"
#               and "dsh-llama-swap" to dsh.profile.bundles
pnpm install
```

Or, from a git checkout:

```bash
dsh plugin add git+https://git.fedesito.me/fedes1to/dsh-llama-swap.git
```

## Settings

On the web client the plugin adds a **llama-swap** section to Settings. It
edits the same three fields as the patch below — server URL, the credential
variable name (not the key), and the catalog cache — and a save takes effect
on the next request, without a restart. A deployment that never composed the
plugin shows no section.

## Configure

Nothing about the deployment is compiled in. The row is inserted with an
empty config; set the endpoint and the credential name in
`~/.dsh/profiles/dsh-tui/cordis.patch.yml`, or use the Settings section:

```yaml
- id: llama-swap
  config:
    baseURL: http://llama-swap.example:8080/v1
    apiKeyEnv: MY_LLAMA_SWAP_KEY
    catalogTTLms: 60000
```

Resolution order, so a deployment can also come from the environment:

| field | config | environment | fallback |
| --- | --- | --- | --- |
| `baseURL` | `baseURL` | `LLAMA_SWAP_BASE_URL` | `http://127.0.0.1:8080/v1` (llama-swap's own default listen address) |
| `apiKeyEnv` | `apiKeyEnv` | `LLAMA_SWAP_API_KEY_ENV` | `LLAMA_SWAP_API_KEY` |

`apiKeyEnv` is a credential reference resolved through the harness credential
seam (`~/.dsh/.credentials.yaml`), falling back to the process environment.
llama-swap's `/v1/models` answers `401 admin login required` without a key, so
a key is required in practice.

## What it maps

| `/v1/models` field | harness effect |
| --- | --- |
| `id`, `name` | picker entry |
| `context_length` / `context_window` | context window |
| `architecture.input_modalities` (or `capabilities.vision`) | `inputModalities` — `in: [text, image]` in config.d is what makes `read_image` work |
| `capabilities.function_calling` | tools |
| `meta.llamaswap.reasoning.efforts` | selectable efforts (+ `off`, which sends `enable_thinking: false`) |
| `meta.llamaswap.reasoning.default` | `defaultEffort` |

Streaming is OpenAI chat completions: `delta.content`,
`delta.reasoning_content` (vLLM's qwen3 reasoning parser), streaming
`tool_calls`, and usage. The selected effort rides as `reasoning_effort`;
thinking is toggled with `chat_template_kwargs.enable_thinking`.

## Limits

- **Vision is opt-in per model.** A model declared `in: [text, image]` in
  llama-swap config.d gets its images through: the harness gates `read_image`
  on the catalog's `inputModalities`, and each live image block rides the
  wire as an OpenAI `image_url` data URL. That needs the durable attachment
  service injected into the composition (`attachments`) — without it a
  request carrying images fails with `UNSUPPORTED_CONTENT` rather than
  silently dropping the picture. Engines that are not vision-armed
  (no `VISION=1` in the launcher) will reject the pixels server-side even
  though the catalog advertises them.
- **Assistant reasoning is not replayed** in history — the OpenAI shape has no
  field for it, and vLLM's template re-derives thinking from the prompt.
- The catalog is cached for `catalogTTLms`; a model added to llama-swap shows
  up after the TTL (or a restart).

## License

Apache-2.0.
