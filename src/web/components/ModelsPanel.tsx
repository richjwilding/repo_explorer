import { buildProviderPatch } from '../lib/providerPatch';
import { useCallback, useEffect, useState } from 'react';
import type { ProviderStatus } from '../../core/types';
import { api } from '../lib/api';
import { describeSaveOutcome, type SaveOutcome } from '../lib/saveOutcome';

interface Settings {
  provider: string;
  model: string | null;
  openaiBaseUrl: string;
  ollamaUrl: string;
  ollamaNumCtx: number;
  credentials: { openai: CredentialSource; anthropic: CredentialSource };
}

type CredentialSource = 'env' | 'dotenv' | 'config' | 'none';

const SOURCE_HINT: Record<CredentialSource, string> = {
  env: 'set by an environment variable',
  dotenv: 'read from .env',
  config: 'saved in config.json (legacy)',
  none: '',
};

interface SettingsResponse {
  providers: ProviderStatus[];
  secretStorage?: { file: string; source: CredentialSource };
  active: ProviderStatus | null;
  activeProviderId?: string;
  selectedProviderId?: string;
  secretsStored?: Record<string, string>;
  settings: Settings;
  configPath: string;
  shadowed?: string[];
}

export interface ModelsPanelProps {
  providers: ProviderStatus[];
  providerId: string;
  onClose: () => void;
  onApplied: (providers: ProviderStatus[], activeProviderId: string, selectedProviderId: string) => void;
}

type Preset = 'anthropic' | 'openai' | 'ollama';

const PRESETS: { id: Preset; label: string; blurb: string; baseUrl?: string }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb: 'Claude models over the Messages API. Best quality for long explainers.',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    blurb: 'OpenAI, Azure-style gateways, Together, Groq, OpenRouter, vLLM.',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'ollama',
    label: 'Ollama (on-device)',
    blurb: 'Nothing leaves this machine. Slower, and answer quality depends on the model.',
  },
];

export function ModelsPanel({ providers, providerId, onClose, onApplied }: ModelsPanelProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configPath, setConfigPath] = useState('');
  const [shadowed, setShadowed] = useState<string[]>([]);
  const [storage, setStorage] = useState<{ file: string; source: CredentialSource | 'none' }>({ file: '', source: 'none' });
  const [storedIn, setStoredIn] = useState<Record<string, string>>({});
  const initialPreset: Preset =
    providerId === 'anthropic' || providerId === 'ollama' || providerId === 'openai' ? providerId : 'openai';
  const [preset, setPreset] = useState<Preset>(initialPreset);
  // A model name belongs to a provider: `qwen3.6:latest` means nothing to
  // Anthropic, so each preset remembers its own.
  const [modelsByPreset, setModelsByPreset] = useState<Record<Preset, string>>({ anthropic: '', openai: '', ollama: '' });
  const model = modelsByPreset[preset];
  const setModel = (value: string) => setModelsByPreset((previous) => ({ ...previous, [preset]: value }));
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((response: SettingsResponse) => {
    setSettings(response.settings);
    setConfigPath(response.configPath);
    setShadowed(response.shadowed ?? []);
    if (response.secretStorage) setStorage(response.secretStorage);
    setBaseUrl(response.settings.openaiBaseUrl);
    setOllamaUrl(response.settings.ollamaUrl);
    setModelsByPreset((previous) => {
      const next = { ...previous };
      for (const provider of response.providers) {
        if (provider.id === 'openai' || provider.id === 'anthropic' || provider.id === 'ollama') {
          // Only fill in what the reader has not typed themselves.
          if (!next[provider.id]) next[provider.id] = provider.defaultModel ?? '';
        }
      }
      return next;
    });
    onApplied(
      response.providers,
      response.activeProviderId ?? response.active?.id ?? providerId,
      response.selectedProviderId ?? preset,
    );
  }, [onApplied, preset, providerId]);

  useEffect(() => {
    void api
      .get<SettingsResponse>('/api/settings')
      .then((response) => {
        apply({ ...response, providers, active: null });
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    // Providers are read fresh from the parent; the panel only loads settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      setOutcome(null);
      try {
        const response = await api.post<SettingsResponse>('/api/settings', patch);
        apply(response);
        setStoredIn(response.secretsStored ?? {});
        setApiKey('');
        setAnthropicKey('');
        setOutcome(
          describeSaveOutcome({
            selectedProviderId: response.selectedProviderId ?? preset,
            activeProviderId: response.activeProviderId ?? response.active?.id ?? '',
            providers: response.providers,
            keyStored: Object.values(response.secretsStored ?? {}).some((where) => where !== 'none'),
          }),
        );
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const chosen = providers.find((provider) => provider.id === preset);
  const credentials = settings?.credentials;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Model settings" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <p className="eyebrow">model settings</p>
            <h2>Choose the language model</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="modal-body">
          <div className="preset-grid">
            {PRESETS.map((option) => {
              const status = providers.find((provider) => provider.id === option.id);
              const available = status?.available ?? false;
              return (
                <button
                  type="button"
                  className={`preset-card ${preset === option.id ? 'active' : ''}`}
                  key={option.id}
                  onClick={() => {
                    setPreset(option.id);
                    setError(null);
                    setOutcome(null);
                    // Only prefill when there is nothing to lose: a custom base
                    // URL is a deliberate setting, not a placeholder.
                    setBaseUrl((current) => current || option.baseUrl || '');
                    setModel(providers.find((provider) => provider.id === option.id)?.defaultModel ?? '');
                  }}
                >
                  <span className="preset-top">
                    <span className="preset-name">{option.label}</span>
                    <span className={`chip ${available ? 'ok' : ''}`}>{available ? 'ready' : 'needs setup'}</span>
                  </span>
                  <span className="preset-blurb">{option.blurb}</span>
                  {status?.detail ? <span className="preset-detail">{status.detail}</span> : null}
                </button>
              );
            })}
          </div>

          {preset === 'anthropic' ? (
            <label className="field">
              <span>
                Anthropic API key
                {credentials?.anthropic && SOURCE_HINT[credentials.anthropic] ? (
                  <span className="muted"> · {SOURCE_HINT[credentials.anthropic]}</span>
                ) : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder={credentials?.anthropic === 'none' ? 'sk-ant-…' : '•••••••• (leave blank to keep)'}
                value={anthropicKey}
                onChange={(event) => setAnthropicKey(event.target.value)}
              />
              <span className="hint">
                Sent only to api.anthropic.com, from your machine.
                {credentials?.anthropic !== 'none' ? (
                  <>
                    {' '}
                    <button type="button" className="link-button" onClick={() => void save({ anthropicApiKey: '' })} disabled={busy}>
                      Remove the stored key
                    </button>
                  </>
                ) : null}
              </span>
            </label>
          ) : null}

          {preset === 'openai' ? (
            <>
              <label className="field">
                <span>Base URL</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder="https://api.openai.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <span className="hint">Anything exposing /chat/completions and /models — OpenAI, Groq, OpenRouter, Together, vLLM, LM Studio.</span>
              </label>
              <label className="field">
                <span>
                  API key
                  {credentials?.openai && SOURCE_HINT[credentials.openai] ? (
                    <span className="muted"> · {SOURCE_HINT[credentials.openai]}</span>
                  ) : null}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={credentials?.openai === 'none' ? 'sk-…' : '•••••••• (leave blank to keep)'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <span className="hint">
                  Leave blank for a local server that needs no key.
                  {credentials?.openai !== 'none' ? (
                    <>
                      {' '}
                      <button type="button" className="link-button" onClick={() => void save({ openaiApiKey: '' })} disabled={busy}>
                        Remove the stored key
                      </button>
                    </>
                  ) : null}
                </span>
              </label>
            </>
          ) : null}

          {preset === 'ollama' ? (
            <label className="field">
              <span>Ollama URL</span>
              <input type="text" spellCheck={false} value={ollamaUrl} onChange={(event) => setOllamaUrl(event.target.value)} />
              <span className="hint">Run `ollama serve` first. Nothing is sent anywhere else.</span>
            </label>
          ) : null}

          <label className="field">
            <span>Model{chosen?.models && chosen.models.length > 0 ? <span className="muted"> · {chosen.models.length} available</span> : null}</span>
            <input
              type="text"
              spellCheck={false}
              list="model-options"
              placeholder="leave blank to pick automatically"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="model-options">
              {(chosen?.models ?? []).map((option) => (
                <option value={option} key={option} />
              ))}
            </datalist>
          </label>

          {outcome ? (
            <div className={outcome.tone === 'ok' ? 'notice-ok' : 'notice-warn'}>
              <strong>{outcome.title}</strong>
              {outcome.detail ? <p>{outcome.detail}</p> : null}
              {storedIn.openaiApiKey || storedIn.anthropicApiKey ? (
                <p className="muted small">
                  Key written to {storage.file || '~/.repo-explorer/.env'} (0600).
                  {Object.values(storedIn).includes('none') ? ' A cleared key was removed.' : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="muted small">
            Keys are read from <code>{storage.file || '~/.repo-explorer/.env'}</code> (or a <code>.env</code> in the working
            directory). A real environment variable takes precedence over the file. Model settings stay in{' '}
            <code>config.json</code>; credentials never go there.
          </p>
          {error ? <div className="error-banner inline">{error}</div> : null}
          {shadowed.length > 0 ? (
            <div className="callout callout-warning">
              <h4>Environment variables are overriding the file</h4>
              <p>
                {shadowed.join(', ')} {shadowed.length === 1 ? 'is' : 'are'} set in your environment, which wins over the saved settings.
                Unset {shadowed.length === 1 ? 'it' : 'them'} (or use the <code>REPO_EXPLORER_</code> prefixed name) if what you type here
                seems to be ignored.
              </p>
            </div>
          ) : null}
        </div>

        <footer className="modal-foot">
          <span className="muted small">Saved to {configPath || '~/.repo-explorer/config.json'}</span>
          <div className="modal-actions">
            {/* One button. There used to be two, and the one labelled "Save and
                test" omitted the API key, so entering a key and pressing it saved
                the provider without the credential. */}
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void save(buildProviderPatch({ preset, apiKey, anthropicKey, openaiBaseUrl: baseUrl, ollamaUrl, model }))}
            >
              {busy ? 'Working…' : 'Save and test'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
