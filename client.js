window.__ModuleLoader__.load({
  id: 'dsh-llama-swap',
  factory: (require) => {
    const jsxRuntime = require('react/jsx-runtime')
    const { jsx, jsxs } = jsxRuntime
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { SettingsForm, SettingsFormModel, SettingsValueField } = primitives

    /**
     * llama-swap settings page. Registers a Settings section — the same seat
     * the subscriptions plugin uses — while the Host serves the `llama-swap`
     * namespace, so a deployment that never composed this plugin shows no
     * trace of it. Saves write the profile's volatile config; the host half
     * reads those fields on every request.
     */
    const NS = 'settings.llamaSwap'

    /** Profile entry id this page edits. Matches the bundle patch row. */
    const ENTRY = 'llama-swap'

    const inject = ['slots', 'locale', 'configForms']

    const en = {
      nav: 'llama-swap',
      description: 'Where this harness reads its model catalog.',
      baseURL: 'Server URL',
      baseURLHint: 'llama-swap OpenAI base, including /v1. Takes effect on the next request.',
      apiKeyEnv: 'API key variable',
      apiKeyEnvHint: 'Name of the credential the key is stored under, not the key itself.',
      catalogTTLms: 'Catalog cache',
      catalogTTLmsHint: 'How long a fetched model list is reused, in milliseconds. Minimum 1000.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalid: 'This value is not valid.',
    }

    const zh = {
      nav: 'llama-swap',
      description: '本 Harness 读取模型目录的位置。',
      baseURL: '服务器地址',
      baseURLHint: 'llama-swap 的 OpenAI 基址，含 /v1。下次请求即生效。',
      apiKeyEnv: 'API 密钥变量',
      apiKeyEnvHint: '密钥所存凭证的名称，而不是密钥本身。',
      catalogTTLms: '目录缓存',
      catalogTTLmsHint: '已获取的模型列表复用多久，单位毫秒。最小 1000。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalid: '这个值无效。',
    }

    /** Blank means "inherit", which is how an optional field returns to its default. */
    function textField(field) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
        },
      }
    }

    /** A catalog TTL below the schema minimum is rejected before it is written. */
    function ttlField() {
      return {
        field: 'catalogTTLms',
        format: (value) => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          const value = Number(trimmed)
          return Number.isInteger(value) && value >= 1000 ? { kind: 'set', value } : undefined
        },
      }
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** One labelled field. The shared field draws the input, badge, and reset. */
    function Field(props) {
      return jsx(SettingsValueField, {
        id: props.id,
        label: props.label,
        hint: props.hint,
        overriddenLabel: props.t('overridden'),
        resetLabel: props.t('reset'),
        invalidLabel: props.t('invalid'),
        numeric: props.numeric,
        disabled: props.disabled,
        text: props.value.text,
        overridden: props.value.overridden,
        invalid: props.value.invalid,
        onEdit: props.onEdit,
        onReset: props.onReset,
      })
    }

    /**
     * The section body. `close` arrives from the shell and is unused: nothing
     * here leaves Settings.
     * @param {object} props owner props plus the injected form face.
     */
    function LlamaSwapSection(props) {
      const state = props.useLlamaSwap((snapshot) => snapshot)
      const disabled = !state.writable
      return jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 },
        children: [
          jsx('p', { style: { margin: 0, opacity: 0.72 }, children: props.t('description') }),
          jsx(SettingsForm, {
            labels: formLabels(props.t),
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children: jsxs('div', {
              style: { display: 'flex', flexDirection: 'column', gap: 14 },
              children: [
                jsx(Field, {
                  t: props.t,
                  id: 'llama-swap-base-url',
                  label: props.t('baseURL'),
                  hint: props.t('baseURLHint'),
                  value: state.baseURL,
                  disabled,
                  onEdit: (text) => props.edit('baseURL', text),
                  onReset: () => props.resetField('baseURL'),
                }),
                jsx(Field, {
                  t: props.t,
                  id: 'llama-swap-api-key-env',
                  label: props.t('apiKeyEnv'),
                  hint: props.t('apiKeyEnvHint'),
                  value: state.apiKeyEnv,
                  disabled,
                  onEdit: (text) => props.edit('apiKeyEnv', text),
                  onReset: () => props.resetField('apiKeyEnv'),
                }),
                jsx(Field, {
                  t: props.t,
                  id: 'llama-swap-catalog-ttl',
                  label: props.t('catalogTTLms'),
                  hint: props.t('catalogTTLmsHint'),
                  numeric: true,
                  value: state.catalogTTLms,
                  disabled,
                  onEdit: (text) => props.edit('catalogTTLms', text),
                  onReset: () => props.resetField('catalogTTLms'),
                }),
              ],
            }),
          }),
        ],
      })
    }

    /** Staged form over the `llama-swap` namespace. */
    class LlamaSwapController {
      /** @param {object} scope the bound settings scope. */
      constructor(scope) {
        this.form = new SettingsFormModel(scope, [textField('baseURL'), textField('apiKeyEnv'), ttlField()])
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        return {
          ...this.form.shell(),
          baseURL: this.form.field('baseURL'),
          apiKeyEnv: this.form.field('apiKeyEnv'),
          catalogTTLms: this.form.field('catalogTTLms'),
        }
      }

      /** Face the section's slot registration injects. */
      inject() {
        return { hooks: { llamaSwap: this.store }, ...this.form.actions() }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /**
     * Mount the page while the Host serves the namespace.
     * @param {object} ctx the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'llama-swap: settings copy')
      const t = ctx.locale.bind(NS)
      const card = new LlamaSwapController(ctx.configForms.get(ENTRY))
      ctx.effect(() => () => card.dispose(), 'llama-swap: settings form')
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'llama-swap',
                  order: 80,
                  label: () => t('nav'),
                  locale: NS,
                  inject: () => card.inject(),
                },
                LlamaSwapSection,
              ),
            ),
          ),
        'llama-swap: settings section',
      )
    }

    return { NS, apply, inject }
  },
})
