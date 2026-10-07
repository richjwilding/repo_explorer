import type { ProviderStatus } from '../../core/types';

/**
 * What to tell the user after they save a model choice.
 *
 * This lives in its own module because the first version of this message was a
 * lie: it always said "this is now the model in use", even when the chosen
 * provider could not be reached and the app had quietly fallen back to a local
 * model. A saved-but-unusable choice looked like a no-op.
 */
export interface SaveOutcome {
  /** True only when the chosen provider is actually the one in use. */
  inUse: boolean;
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
}

export interface SaveOutcomeInput {
  selectedProviderId: string;
  activeProviderId: string;
  providers: ProviderStatus[];
  /** Whether a key was written by this save. */
  keyStored: boolean;
}

export function describeSaveOutcome(input: SaveOutcomeInput): SaveOutcome {
  const { selectedProviderId, activeProviderId, providers, keyStored } = input;
  const chosen = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const inUse = providers.find((provider) => provider.id === activeProviderId) ?? null;
  const chosenLabel = chosen?.label ?? selectedProviderId;
  const inUseLabel = inUse?.label ?? activeProviderId;

  if (selectedProviderId === activeProviderId) {
    return {
      inUse: true,
      tone: 'ok',
      title: `Now using ${chosenLabel}.`,
      detail: 'It will be remembered next time you start the app.',
    };
  }

  // Auto-detection is not a failure: there is nothing to fall back *from*.
  if (selectedProviderId === 'auto') {
    return {
      inUse: true,
      tone: 'ok',
      title: `Using ${inUseLabel}.`,
      detail: 'This is chosen automatically from what is available.',
    };
  }

  const reason = chosen?.detail?.trim();
  const missingKey = chosen ? chosen.credential?.present === false : false;

  return {
    inUse: false,
    tone: 'warn',
    title: `Saved, but ${chosenLabel} cannot be used yet — still running on ${inUseLabel}.`,
    detail: [
      keyStored ? 'Your key was saved.' : '',
      reason ? `The provider reported: ${reason}` : '',
      missingKey ? 'Paste the key again — it does not appear to have been accepted.' : '',
      'Nothing is broken: requests keep working on the current model until this is fixed.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
