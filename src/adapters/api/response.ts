import { z } from 'zod';
import { AppError } from '../../errors.js';

const identity = z.string().min(1).max(200);
const text = z.string().min(1);
const noItems = z.array(z.never()).length(0).nullish();
const claudeResponse = z.object({
  id: identity,
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: identity,
  stop_reason: z.enum(['end_turn', 'refusal']),
  stop_sequence: z.null().optional(),
  content: z
    .array(
      z.strictObject({
        type: z.literal('text'),
        text,
        // This adapter cannot preserve citation metadata. Do not silently discard it.
        citations: noItems,
      }),
    )
    .min(1)
    .max(128),
});
const chatResponse = z.object({
  id: identity,
  object: z.literal('chat.completion'),
  model: identity,
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.literal('stop'),
        message: z.strictObject({
          role: z.literal('assistant'),
          content: text,
          refusal: z.null().optional(),
          tool_calls: noItems,
          function_call: z.null().optional(),
          audio: z.null().optional(),
          annotations: noItems,
          // Provider reasoning is not assistant answer text. Never expose or replay it.
          reasoning_content: z.string().nullish(),
        }),
      }),
    )
    .length(1),
});

/** Reject incomplete, tool-bearing, ambiguous, or different-model results in full. */
export function parseApiText(value: unknown, model: string, claude: boolean): string {
  if (claude) {
    const parsed = claudeResponse.safeParse(value);
    if (!parsed.success || parsed.data.model !== model) throw invalidResponse();
    const answer = parsed.data.content.map((block) => block.text).join('');
    if (answer.trim().length === 0) throw invalidResponse();
    return answer;
  }
  const parsed = chatResponse.safeParse(value);
  if (!parsed.success || parsed.data.model !== model) throw invalidResponse();
  const answer = parsed.data.choices[0]?.message.content;
  if (!answer || answer.trim().length === 0) throw invalidResponse();
  return answer;
}

export function invalidResponse(): AppError {
  return new AppError(
    'provider_unavailable',
    'The API did not return one complete, supported text response from the configured model.',
    'No partial answer was returned and no request was retried. Use an exact model ID, not an alias that resolves to another ID.',
  );
}
