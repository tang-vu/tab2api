import { randomUUID } from 'node:crypto';

export const API_MODEL = 'chatgpt-web' as const;

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: typeof API_MODEL;
  choices: Array<{
    index: 0;
    message: { role: 'assistant'; content: string; refusal: null };
    logprobs: null;
    finish_reason: 'stop';
  }>;
  usage: { prompt_tokens: 0; completion_tokens: 0; total_tokens: 0 };
  tab2api: { usage_available: false; stream_mode: 'buffered' };
}

export function mapChatCompletion(text: string, now = Date.now()): ChatCompletionResponse {
  return {
    id: `chatcmpl_${randomUUID().replaceAll('-', '')}`,
    object: 'chat.completion',
    created: Math.floor(now / 1000),
    model: API_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    tab2api: { usage_available: false, stream_mode: 'buffered' },
  };
}

export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed';
  error: null;
  incomplete_details: null;
  instructions: null;
  model: typeof API_MODEL;
  output: Array<{
    id: string;
    type: 'message';
    status: 'completed';
    role: 'assistant';
    content: Array<{ type: 'output_text'; text: string; annotations: []; logprobs: [] }>;
  }>;
  parallel_tool_calls: false;
  temperature: null;
  tool_choice: 'none';
  tools: [];
  usage: null;
  metadata: { tab2api_stream_mode: 'buffered'; tab2api_usage_available: 'false' };
}

export function mapResponse(text: string, now = Date.now()): ResponsesResponse {
  const compactId = randomUUID().replaceAll('-', '');
  return {
    id: `resp_${compactId}`,
    object: 'response',
    created_at: Math.floor(now / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    model: API_MODEL,
    output: [
      {
        id: `msg_${compactId}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'none',
    tools: [],
    usage: null,
    metadata: { tab2api_stream_mode: 'buffered', tab2api_usage_available: 'false' },
  };
}

export function chatSse(response: ChatCompletionResponse): string {
  const base = {
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created,
    model: response.model,
  };
  const start = {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
  };
  const content = {
    ...base,
    choices: [
      {
        index: 0,
        delta: { content: response.choices[0]?.message.content ?? '' },
        logprobs: null,
        finish_reason: null,
      },
    ],
  };
  const end = {
    ...base,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
  };
  return (
    [start, content, end].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

export function responsesSse(response: ResponsesResponse): string {
  const item = response.output[0];
  const text = item?.content[0]?.text ?? '';
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item?.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item?.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      item_id: item?.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: item?.id,
      output_index: 0,
      content_index: 0,
      part: item?.content[0],
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return events
    .map((event, sequenceNumber) => ({ ...event, sequence_number: sequenceNumber }))
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}
