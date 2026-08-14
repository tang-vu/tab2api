import { z } from 'zod';

const textPart = z.object({ type: z.literal('text'), text: z.string().min(1) }).strict();
const inputTextPart = z.object({ type: z.literal('input_text'), text: z.string().min(1) }).strict();

export const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string().min(1), z.array(textPart).min(1)]),
  })
  .strict();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1).max(200),
    stream: z.boolean().default(false),
    user: z.string().optional(),
  })
  .strict();

const responseInputMessage = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string().min(1), z.array(inputTextPart).min(1)]),
  })
  .strict();

export const responsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(responseInputMessage).min(1).max(200)]),
    instructions: z.string().min(1).optional(),
    stream: z.boolean().default(false),
    user: z.string().optional(),
  })
  .strict();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type Message = z.infer<typeof chatMessageSchema>;
