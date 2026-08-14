import { z } from 'zod';

const dataImageUrl = z
  .string()
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const textPart = z.object({ type: z.literal('text'), text: z.string().min(1) }).strict();
const imagePart = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: dataImageUrl,
        detail: z.enum(['auto', 'low', 'high']).optional(),
      })
      .strict(),
  })
  .strict();
const inputTextPart = z.object({ type: z.literal('input_text'), text: z.string().min(1) }).strict();
const inputImagePart = z
  .object({
    type: z.literal('input_image'),
    image_url: dataImageUrl,
    detail: z.enum(['auto', 'low', 'high']).optional(),
  })
  .strict();

export const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string().min(1), z.array(z.union([textPart, imagePart])).min(1)]),
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
    content: z.union([z.string().min(1), z.array(z.union([inputTextPart, inputImagePart])).min(1)]),
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

export const imageGenerationRequestSchema = z
  .object({
    model: z.string().min(1).default('chatgpt-web-image'),
    prompt: z.string().min(1).max(32_000),
    n: z.literal(1).default(1),
    size: z.literal('auto').default('auto'),
    quality: z.literal('auto').default('auto'),
    response_format: z.literal('b64_json').default('b64_json'),
    user: z.string().optional(),
  })
  .strict();

export const speechRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.string().min(1).max(4096),
    voice: z.string().min(1),
    response_format: z.literal('wav').default('wav'),
    speed: z.number().min(0.5).max(2).default(1),
  })
  .strict();
