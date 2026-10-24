import { AppError } from '../errors.js';
import type { GenerateRequest, WebProviderId } from '../provider.js';

export interface ProviderCapabilities {
  text: boolean;
  attachments: boolean;
  images: boolean;
  transcription: boolean;
  projects: boolean;
  conversations: boolean;
  temporaryChat: boolean;
  effort: boolean;
  streamMode: 'buffered';
}

const textOnly: ProviderCapabilities = {
  text: true,
  attachments: false,
  images: false,
  transcription: false,
  projects: false,
  conversations: false,
  temporaryChat: false,
  effort: false,
  streamMode: 'buffered',
};

/** Static discovery never opens a browser or implies that the user is signed in. */
export const PROVIDER_CATALOG = [
  {
    id: 'chatgpt-web',
    name: 'ChatGPT',
    transport: 'browser-ui',
    status: 'existing-adapter',
    webUrl: 'https://chatgpt.com/',
    termsUrl: 'https://openai.com/policies/terms-of-use/',
    capabilities: {
      ...textOnly,
      attachments: true,
      images: true,
      transcription: true,
      projects: true,
      conversations: true,
      temporaryChat: true,
      effort: true,
    },
  },
  {
    id: 'claude-web',
    name: 'Claude',
    transport: 'browser-ui',
    status: 'experimental-permission-required',
    webUrl: 'https://claude.ai/new',
    termsUrl: 'https://www.anthropic.com/legal/consumer-terms',
    liveVerified: false,
    capabilities: textOnly,
  },
  {
    id: 'grok-web',
    name: 'Grok',
    transport: 'browser-ui',
    status: 'experimental-permission-required',
    webUrl: 'https://grok.com/',
    termsUrl: 'https://x.ai/legal/acceptable-use-policy',
    liveVerified: false,
    capabilities: textOnly,
  },
  {
    id: 'meta-ai-web',
    name: 'Meta AI / Muse Spark',
    transport: 'browser-ui',
    status: 'not-implemented',
    webUrl: 'https://meta.ai/',
    apiDocumentationUrl: 'https://dev.meta.ai/docs/overview',
    liveVerified: false,
    capabilities: { ...textOnly, text: false },
  },
] as const;

export function providerCapabilities(id: WebProviderId): Readonly<ProviderCapabilities> {
  return id === 'chatgpt-web' ? PROVIDER_CATALOG[0].capabilities : textOnly;
}

export function anthropicModelFor(id: WebProviderId): string {
  return `claude-tab2api-${id}`;
}

export function validateProviderConfiguration(config: {
  provider: WebProviderId;
  experimentalProviders: boolean;
  providerPermission: 'claude-web' | 'grok-web' | undefined;
}): void {
  if (config.provider === 'chatgpt-web') return;
  if (!config.experimentalProviders || config.providerPermission !== config.provider) {
    throw new AppError(
      'provider_unavailable',
      `${config.provider} is disabled: this experimental adapter requires actual provider permission for automated web access.`,
      'Only after obtaining that permission, set TAB2API_EXPERIMENTAL_PROVIDERS=true and TAB2API_PROVIDER_PERMISSION to the exact provider id. These flags do not grant permission or override provider terms.',
    );
  }
}

/** Never silently send a named provider's prompt to a different provider. */
export function assertProviderModel(id: WebProviderId, model: string): void {
  const knownIds = PROVIDER_CATALOG.flatMap((provider) => [
    provider.id,
    `claude-tab2api-${provider.id}`,
  ]);
  if (model === id || model === anthropicModelFor(id)) return;
  // Existing ChatGPT clients used arbitrary aliases. Preserve that compatibility, but
  // reserved provider identifiers must always resolve truthfully.
  if (id === 'chatgpt-web' && !knownIds.includes(model)) return;
  throw new AppError(
    'invalid_request',
    `Model ${model} is not available in this runtime. Use ${id}; configure a separate runtime for another provider.`,
  );
}

export function assertProviderCapability(
  id: WebProviderId,
  capability: Exclude<keyof ProviderCapabilities, 'streamMode'>,
): void {
  if (!providerCapabilities(id)[capability]) {
    throw new AppError('unsupported_capability', `${id} does not support ${capability}.`);
  }
}

export function assertTextCapabilities(
  id: WebProviderId,
  request: Pick<
    GenerateRequest,
    'attachments' | 'projectId' | 'conversationId' | 'temporary' | 'effort'
  >,
): void {
  if ((request.attachments?.length ?? 0) > 0) assertProviderCapability(id, 'attachments');
  if (request.projectId !== undefined) assertProviderCapability(id, 'projects');
  if (request.conversationId !== undefined) assertProviderCapability(id, 'conversations');
  if (request.temporary === true) assertProviderCapability(id, 'temporaryChat');
  if (request.effort !== undefined) assertProviderCapability(id, 'effort');
}
