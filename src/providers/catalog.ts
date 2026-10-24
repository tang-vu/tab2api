import { AppError } from '../errors.js';
import type { ApiProviderId, GenerateRequest, ProviderId } from '../provider.js';

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
    id: 'claude-api',
    name: 'Claude API',
    transport: 'official-api',
    status: 'implemented-offline-tested',
    liveVerified: false,
    mayIncurCharges: true,
    apiDocumentationUrl: 'https://platform.claude.com/docs/en/api/messages/create',
    capabilities: textOnly,
  },
  {
    id: 'grok-api',
    name: 'Grok API',
    transport: 'official-api',
    status: 'implemented-offline-tested',
    liveVerified: false,
    mayIncurCharges: true,
    apiDocumentationUrl: 'https://docs.x.ai/developers/model-capabilities/legacy/chat-completions',
    capabilities: textOnly,
  },
  {
    id: 'meta-api',
    name: 'Meta Model API / Muse Spark',
    transport: 'official-api',
    status: 'implemented-offline-tested',
    liveVerified: false,
    mayIncurCharges: true,
    apiDocumentationUrl: 'https://dev.meta.ai/docs/protocols/chat-completions',
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

export function isApiProvider(id: ProviderId): id is ApiProviderId {
  return id === 'claude-api' || id === 'grok-api' || id === 'meta-api';
}

export function providerCapabilities(id: ProviderId): Readonly<ProviderCapabilities> {
  return id === 'chatgpt-web' ? PROVIDER_CATALOG[0].capabilities : textOnly;
}

export function anthropicModelFor(id: ProviderId): string {
  return `claude-tab2api-${id}`;
}

export function validateProviderConfiguration(config: {
  provider: ProviderId;
  experimentalProviders: boolean;
  providerPermission: 'claude-web' | 'grok-web' | undefined;
}): void {
  if (config.provider === 'chatgpt-web' || isApiProvider(config.provider)) return;
  if (!config.experimentalProviders || config.providerPermission !== config.provider) {
    throw new AppError(
      'provider_unavailable',
      `${config.provider} is disabled: this experimental adapter requires actual provider permission for automated web access.`,
      'Only after obtaining that permission, set TAB2API_EXPERIMENTAL_PROVIDERS=true and TAB2API_PROVIDER_PERMISSION to the exact provider id. These flags do not grant permission or override provider terms.',
    );
  }
}

/** Never silently send a named provider's prompt to a different provider. */
export function assertProviderModel(id: ProviderId, model: string): void {
  const knownIds = PROVIDER_CATALOG.flatMap((provider) => [
    provider.id,
    `claude-tab2api-${provider.id}`,
  ]);
  if (model === id || model === anthropicModelFor(id)) return;
  // Existing ChatGPT clients used arbitrary aliases. Preserve that compatibility, but
  // reserved provider identifiers must always resolve truthfully.
  if (
    id === 'chatgpt-web' &&
    !knownIds.includes(model) &&
    !/^(?:claude|grok|muse|meta)(?:$|[-_/])/i.test(model)
  )
    return;
  throw new AppError(
    'invalid_request',
    `Model ${model} is not available in this runtime. Use ${id}; configure a separate runtime for another provider.`,
  );
}

export function assertProviderCapability(
  id: ProviderId,
  capability: Exclude<keyof ProviderCapabilities, 'streamMode'>,
): void {
  if (!providerCapabilities(id)[capability]) {
    throw new AppError('unsupported_capability', `${id} does not support ${capability}.`);
  }
}

export function assertTextCapabilities(
  id: ProviderId,
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
