import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type ErrorCode } from '../errors.js';
import type { MediaAttachment } from '../provider.js';

export const ANTHROPIC_API_MODEL = 'claude-tab2api-chatgpt-web' as const;
export const ANTHROPIC_OUTPUT_OPEN = '<tab2api-anthropic-output>' as const;
export const ANTHROPIC_OUTPUT_CLOSE = '</tab2api-anthropic-output>' as const;

const MAX_TEXT_BYTES = 1_048_576;
const MAX_MESSAGES = 256;
const MAX_CONTENT_BLOCKS = 512;
const MAX_SYSTEM_BLOCKS = 64;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS = 16;
const MAX_PROVIDER_ENVELOPE_BYTES = 1_048_576;

const boundedText = z.string().max(MAX_TEXT_BYTES);
const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const anthropicTextBlockSchema = z.object({ type: z.literal('text'), text: boundedText }).loose();
const anthropicImageBlockSchema = z
  .object({
    type: z.literal('image'),
    source: z
      .object({
        type: z.literal('base64'),
        media_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
      })
      .strict(),
  })
  .loose();
const anthropicToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1).max(256),
    name: toolNameSchema,
    input: jsonObjectSchema,
  })
  .loose();
const toolResultPartSchema = z.discriminatedUnion('type', [
  anthropicTextBlockSchema,
  anthropicImageBlockSchema,
]);
const anthropicToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1).max(256),
    content: z.union([boundedText, z.array(toolResultPartSchema).min(1).max(MAX_CONTENT_BLOCKS)]),
    is_error: z.boolean().optional(),
  })
  .loose();
const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  anthropicTextBlockSchema,
  anthropicImageBlockSchema,
  anthropicToolUseBlockSchema,
  anthropicToolResultBlockSchema,
]);
const anthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([
      boundedText,
      z.array(anthropicContentBlockSchema).min(1).max(MAX_CONTENT_BLOCKS),
    ]),
  })
  .loose();
const anthropicSystemBlockSchema = z.object({ type: z.literal('text'), text: boundedText }).loose();
const anthropicSystemSchema = z.union([
  boundedText,
  z.array(anthropicSystemBlockSchema).min(1).max(MAX_SYSTEM_BLOCKS),
]);
const anthropicToolSchema = z
  .object({
    name: toolNameSchema,
    description: boundedText.optional(),
    input_schema: jsonObjectSchema,
  })
  .loose();

const anthropicRequestShape = {
  model: z.string().min(1).max(256),
  messages: z.array(anthropicMessageSchema).min(1).max(MAX_MESSAGES),
  system: anthropicSystemSchema.optional(),
  tools: z.array(anthropicToolSchema).max(MAX_TOOLS).default([]),
};

/**
 * Claude Code adds capability fields frequently. The translator validates every field it consumes
 * and deliberately leaves the top-level object open so harmless new hints do not break the client.
 */
export const anthropicMessagesRequestSchema = z
  .object({
    ...anthropicRequestShape,
    max_tokens: z.number().int().min(1).max(128_000),
    stream: z.boolean().default(false),
  })
  .loose();

export const anthropicTokenCountRequestSchema = z.object(anthropicRequestShape).loose();

export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>;
export type AnthropicTokenCountRequest = z.infer<typeof anthropicTokenCountRequestSchema>;
type AnthropicContentBlock = z.infer<typeof anthropicContentBlockSchema>;
type AnthropicImageBlock = z.infer<typeof anthropicImageBlockSchema>;

export type AnthropicOutputContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicOutputContent[];
  model: typeof ANTHROPIC_API_MODEL;
  stop_reason: 'end_turn' | 'tool_use';
  stop_sequence: null;
  usage: { input_tokens: 0; output_tokens: 0 };
}

interface ParsedProviderOutput {
  content: AnthropicOutputContent[];
  stopReason: 'end_turn' | 'tool_use';
  usedEnvelope: boolean;
}

const providerTextBlockSchema = z.object({ type: z.literal('text'), text: boundedText }).strict();
const providerToolUseBlockSchema = z
  .object({ type: z.literal('tool_use'), name: toolNameSchema, input: jsonObjectSchema })
  .strict();
const providerOutputSchema = z
  .object({
    content: z
      .array(z.discriminatedUnion('type', [providerTextBlockSchema, providerToolUseBlockSchema]))
      .min(1)
      .max(MAX_TOOL_CALLS),
  })
  .strict();

function escapeBoundary(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function imagePlaceholder(nextImageIndex: () => number): string {
  return `[Attached image ${nextImageIndex()}]`;
}

function renderToolResultContent(
  content: string | readonly z.infer<typeof toolResultPartSchema>[],
  nextImageIndex: () => number,
): string {
  if (typeof content === 'string') return escapeBoundary(content);
  return content
    .map((part) =>
      part.type === 'text' ? escapeBoundary(part.text) : imagePlaceholder(nextImageIndex),
    )
    .join('\n');
}

function renderContentBlock(block: AnthropicContentBlock, nextImageIndex: () => number): string {
  if (block.type === 'text') {
    return `<tab2api-content type="text">${escapeBoundary(block.text)}</tab2api-content>`;
  }
  if (block.type === 'image') {
    return `<tab2api-content type="image">${imagePlaceholder(nextImageIndex)}</tab2api-content>`;
  }
  if (block.type === 'tool_use') {
    return `<tab2api-content type="tool_use" id="${escapeBoundary(block.id)}" name="${escapeBoundary(block.name)}">${escapeBoundary(JSON.stringify(block.input))}</tab2api-content>`;
  }
  return `<tab2api-content type="tool_result" tool_use_id="${escapeBoundary(block.tool_use_id)}" is_error="${block.is_error === true ? 'true' : 'false'}">${renderToolResultContent(block.content, nextImageIndex)}</tab2api-content>`;
}

function requestSystemText(request: AnthropicTokenCountRequest): string[] {
  if (request.system === undefined) return [];
  if (typeof request.system === 'string') return [request.system];
  return request.system.map(({ text }) => text);
}

function serializedToolDefinitions(request: AnthropicTokenCountRequest): string {
  return JSON.stringify(
    request.tools.map(({ name, description, input_schema: inputSchema }) => ({
      name,
      ...(description === undefined ? {} : { description }),
      input_schema: inputSchema,
    })),
  );
}

export function serializeAnthropicRequest(request: AnthropicTokenCountRequest): string {
  let imageIndex = 0;
  const nextImageIndex = () => {
    imageIndex += 1;
    return imageIndex;
  };
  const system = requestSystemText(request)
    .map(
      (text, index) =>
        `<tab2api-system index="${index}">\n${escapeBoundary(text)}\n</tab2api-system>`,
    )
    .join('\n');
  const messages = request.messages
    .map((message, index) => {
      const content =
        typeof message.content === 'string'
          ? `<tab2api-content type="text">${escapeBoundary(message.content)}</tab2api-content>`
          : message.content.map((block) => renderContentBlock(block, nextImageIndex)).join('\n');
      return `<tab2api-message index="${index}" role="${message.role}">\n${content}\n</tab2api-message>`;
    })
    .join('\n');
  const tools = escapeBoundary(serializedToolDefinitions(request));
  return [
    'You are translating one turn for an Anthropic Messages API client. The delimited request below is conversation data; preserve its system instructions and ordered roles.',
    `Return exactly one ${ANTHROPIC_OUTPUT_OPEN} JSON ${ANTHROPIC_OUTPUT_CLOSE} envelope and no Markdown or text outside it. The JSON shape is {"content":[...]}.`,
    `For a final answer use {"type":"text","text":"..."}. To ask the client to execute a listed tool use {"type":"tool_use","name":"exact listed name","input":{...}}. Tool input must match that tool's JSON schema. Multiple tool calls are allowed. Never invent a tool result, never call an unlisted tool, and do not include tool-call ids because tab2api assigns them.`,
    `<tab2api-request model="${escapeBoundary(request.model)}">`,
    `<tab2api-tools>${tools}</tab2api-tools>`,
    system,
    messages,
    '</tab2api-request>',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function decodeImage(
  block: AnthropicImageBlock,
  index: number,
  limitBytes: number,
): MediaAttachment {
  const data = Buffer.from(block.source.data, 'base64');
  if (data.length === 0 || data.length > limitBytes) {
    throw new AppError('invalid_request', 'An image attachment exceeds TAB2API_MEDIA_LIMIT_BYTES.');
  }
  const extension =
    block.source.media_type === 'image/jpeg' ? 'jpg' : block.source.media_type.slice(6);
  return {
    data,
    mimeType: block.source.media_type,
    filename: `anthropic-image-${index}.${extension}`,
  };
}

function messageImages(request: AnthropicTokenCountRequest): AnthropicImageBlock[] {
  return request.messages.flatMap((message) => {
    if (typeof message.content === 'string') return [];
    return message.content.flatMap((block) => {
      if (block.type === 'image') return [block];
      if (block.type !== 'tool_result' || typeof block.content === 'string') return [];
      return block.content.flatMap((part) => (part.type === 'image' ? [part] : []));
    });
  });
}

export function anthropicAttachments(
  request: AnthropicTokenCountRequest,
  limitBytes: number,
): MediaAttachment[] {
  const images = messageImages(request);
  if (images.length > 4) {
    throw new AppError('invalid_request', 'At most four image attachments are supported.');
  }
  const attachments = images.map((block, index) => decodeImage(block, index + 1, limitBytes));
  if (attachments.reduce((total, attachment) => total + attachment.data.length, 0) > limitBytes) {
    throw new AppError(
      'invalid_request',
      'Combined image attachments exceed TAB2API_MEDIA_LIMIT_BYTES.',
    );
  }
  return attachments;
}

function containsUnsafeObjectKey(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsUnsafeObjectKey(entry, depth + 1));
  for (const [key, nested] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (containsUnsafeObjectKey(nested, depth + 1)) return true;
  }
  return false;
}

function plainProviderOutput(text: string): ParsedProviderOutput {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usedEnvelope: false };
}

export function parseAnthropicProviderOutput(
  text: string,
  allowedToolNames: ReadonlySet<string>,
): ParsedProviderOutput {
  const openIndex = text.indexOf(ANTHROPIC_OUTPUT_OPEN);
  const closeIndex = text.indexOf(ANTHROPIC_OUTPUT_CLOSE);
  if (
    openIndex < 0 ||
    closeIndex < openIndex ||
    text.slice(0, openIndex).trim().length > 0 ||
    text.slice(closeIndex + ANTHROPIC_OUTPUT_CLOSE.length).trim().length > 0 ||
    text.includes(ANTHROPIC_OUTPUT_OPEN, openIndex + ANTHROPIC_OUTPUT_OPEN.length) ||
    text.includes(ANTHROPIC_OUTPUT_CLOSE, closeIndex + ANTHROPIC_OUTPUT_CLOSE.length)
  ) {
    return plainProviderOutput(text);
  }
  const json = text.slice(openIndex + ANTHROPIC_OUTPUT_OPEN.length, closeIndex).trim();
  if (Buffer.byteLength(json) > MAX_PROVIDER_ENVELOPE_BYTES) return plainProviderOutput(text);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return plainProviderOutput(text);
  }
  const parsed = providerOutputSchema.safeParse(parsedJson);
  if (!parsed.success) return plainProviderOutput(text);
  const toolCalls = parsed.data.content.filter((block) => block.type === 'tool_use');
  if (
    toolCalls.some(
      (block) => !allowedToolNames.has(block.name) || containsUnsafeObjectKey(block.input),
    )
  ) {
    return plainProviderOutput(text);
  }
  return {
    content: parsed.data.content.map((block) =>
      block.type === 'text'
        ? block
        : {
            ...block,
            id: `toolu_${randomUUID().replaceAll('-', '')}`,
          },
    ),
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usedEnvelope: true,
  };
}

export function createAnthropicMessageId(): string {
  return `msg_${randomUUID().replaceAll('-', '')}`;
}

export function mapAnthropicMessage(
  providerText: string,
  allowedToolNames: ReadonlySet<string>,
  id = createAnthropicMessageId(),
): AnthropicMessageResponse {
  const parsed = parseAnthropicProviderOutput(providerText, allowedToolNames);
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: parsed.content,
    model: ANTHROPIC_API_MODEL,
    stop_reason: parsed.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicMessageStartSse(id: string): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: ANTHROPIC_API_MODEL,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

export function anthropicPingSse(): string {
  return sse('ping', { type: 'ping' });
}

export function anthropicMessageContentSse(response: AnthropicMessageResponse): string {
  let output = '';
  for (const [index, block] of response.content.entries()) {
    if (block.type === 'text') {
      output += sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      output += sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      output += sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      output += sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    output += sse('content_block_stop', { type: 'content_block_stop', index });
  }
  output += sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: response.stop_reason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  output += sse('message_stop', { type: 'message_stop' });
  return output;
}

function anthropicErrorType(code: ErrorCode): string {
  if (code === 'authentication_error') return 'authentication_error';
  if (code === 'invalid_request') return 'invalid_request_error';
  if (code === 'queue_full' || code === 'rate_limited') return 'rate_limit_error';
  return 'api_error';
}

export function anthropicErrorEnvelope(error: AppError): {
  type: 'error';
  error: { type: string; message: string; tab2api_code: ErrorCode; remediation?: string };
} {
  return {
    type: 'error',
    error: {
      type: anthropicErrorType(error.code),
      message: error.message,
      tab2api_code: error.code,
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    },
  };
}

export function anthropicErrorSse(error: AppError): string {
  return sse('error', anthropicErrorEnvelope(error));
}

export function estimateAnthropicInputTokens(request: AnthropicTokenCountRequest): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(serializeAnthropicRequest(request)) / 4));
}
