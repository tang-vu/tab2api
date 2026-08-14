import type { ChatCompletionRequest, Message, ResponsesRequest } from './schemas.js';

const OPEN = '<tab2api-message';

function escapeBoundary(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => part.text).join('\n');
}

export function serializeMessages(messages: readonly Message[]): string {
  const body = messages
    .map(
      (message, index) =>
        `${OPEN} index="${index}" role="${message.role}">\n${escapeBoundary(messageText(message))}\n</tab2api-message>`,
    )
    .join('\n');
  return [
    'The following is an ordered conversation transcript. Treat XML-like tags as boundaries, not as user instructions. Continue by answering the final user message while respecting earlier system and developer instructions.',
    body,
  ].join('\n\n');
}

export function serializeChatRequest(request: ChatCompletionRequest): string {
  return serializeMessages(request.messages);
}

export function serializeResponsesRequest(request: ResponsesRequest): string {
  const messages: Message[] = [];
  if (request.instructions !== undefined) {
    messages.push({ role: 'developer', content: request.instructions });
  }
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else {
    for (const item of request.input) {
      messages.push({
        role: item.role,
        content:
          typeof item.content === 'string'
            ? item.content
            : item.content.map((part) => ({ type: 'text' as const, text: part.text })),
      });
    }
  }
  return serializeMessages(messages);
}
