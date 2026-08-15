import { AppError } from '../../errors.js';

export const CHATGPT_URL = 'https://chatgpt.com/';
export const PROJECTS_URL = 'https://chatgpt.com/projects';

/**
 * Both identifiers are interpolated into a chatgpt.com URL. The patterns are anchored and
 * charset-restricted so a hostile value cannot escape the intended path, walk to another
 * route, or point the tab at a different origin.
 */
const PROJECT_ID_PATTERN = /^g-p-[0-9a-f]{16,64}$/;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function projectUrl(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId))
    throw new AppError('invalid_request', 'The project id is not a ChatGPT project identifier.');
  return `${CHATGPT_URL}g/${projectId}/project`;
}

export function conversationUrl(conversationId: string): string {
  if (!CONVERSATION_ID_PATTERN.test(conversationId))
    throw new AppError('invalid_request', 'The conversation id is not a ChatGPT conversation id.');
  return `${CHATGPT_URL}c/${conversationId}`;
}

export function conversationIdFromUrl(url: string): string | undefined {
  return /\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/.exec(url)?.[1];
}

export function projectIdFromHref(href: string): string | undefined {
  return /\/g\/(g-p-[0-9a-f]{16,64})\b/.exec(href)?.[1];
}
