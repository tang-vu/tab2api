import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { AppConfig } from '../config/index.js';
import { AppError, asSafeAppError } from '../errors.js';
import type { WebChatProvider } from '../provider.js';
import { FifoQueue } from '../queue/fifo.js';
import { parseBearer, secureTokenEqual } from '../security/token.js';
import { MetadataStore } from '../store/metadata.js';
import { API_MODEL, chatSse, mapChatCompletion, mapResponse, responsesSse } from './mappers.js';
import { chatCompletionRequestSchema, responsesRequestSchema } from './schemas.js';
import { serializeChatRequest, serializeResponsesRequest } from './serializer.js';

interface ErrorEnvelope {
  error: { message: string; type: string; code: string; param: null; remediation?: string };
}

function errorEnvelope(error: AppError): ErrorEnvelope {
  const detail: ErrorEnvelope['error'] = {
    message: error.message,
    type: error.code === 'invalid_request' ? 'invalid_request_error' : 'tab2api_error',
    code: error.code,
    param: null,
  };
  if (error.remediation !== undefined) detail.remediation = error.remediation;
  return { error: detail };
}

function authenticate(request: FastifyRequest, token: string): void {
  const presented = parseBearer(request.headers.authorization);
  if (presented === undefined || !secureTokenEqual(presented, token)) {
    throw new AppError('authentication_error', 'A valid local bearer token is required.');
  }
}

function requestAbortController(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new AppError('timeout', 'The request exceeded the configured timeout.')),
    timeoutMs,
  );
  const onAborted = () => controller.abort(new AppError('cancelled', 'The client disconnected.'));
  const onResponseClose = () => {
    if (!reply.raw.writableEnded) onAborted();
  };
  request.raw.once('aborted', onAborted);
  reply.raw.once('close', onResponseClose);
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      request.raw.removeListener('aborted', onAborted);
      reply.raw.removeListener('close', onResponseClose);
    },
  };
}

export interface ServerDependencies {
  config: AppConfig;
  provider: WebChatProvider;
  logger: Logger;
  queue?: FifoQueue;
  store?: MetadataStore;
}

export function buildServer(dependencies: ServerDependencies) {
  const { config, provider, logger } = dependencies;
  const queue = dependencies.queue ?? new FifoQueue(config.concurrency, config.queueCapacity);
  const store = dependencies.store ?? new MetadataStore();
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs + 5_000,
    genReqId: () => randomUUID(),
    trustProxy: false,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });

  app.addHook('onRequest', async (request) => {
    request.log.info({ req: request }, 'request started');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ requestId: request.id, statusCode: reply.statusCode }, 'request completed');
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'tab2api' }));
  app.get('/readyz', async (_request, reply) => {
    const session = await provider.health();
    const ready = session === 'ready';
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', session });
  });

  const authenticated = (request: FastifyRequest) =>
    Promise.resolve(authenticate(request, config.apiToken));

  app.get('/v1/models', { preHandler: authenticated }, async () => ({
    object: 'list',
    data: [
      {
        id: API_MODEL,
        object: 'model',
        created: 0,
        owned_by: 'user-browser-session',
      },
    ],
  }));

  app.post('/v1/chat/completions', { preHandler: authenticated }, async (request, reply) => {
    const body = chatCompletionRequestSchema.parse(request.body);
    const lifecycle = requestAbortController(request, reply, config.requestTimeoutMs);
    try {
      const result = await queue.enqueue(
        () =>
          provider.generate({
            prompt: serializeChatRequest(body),
            signal: lifecycle.controller.signal,
            requestId: request.id,
          }),
        lifecycle.controller.signal,
      );
      const response = mapChatCompletion(result.text);
      store.set({ id: response.id, createdAt: response.created, status: 'completed' });
      if (body.stream) {
        return reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache')
          .header('x-tab2api-stream-mode', 'buffered')
          .send(chatSse(response));
      }
      return response;
    } finally {
      lifecycle.dispose();
    }
  });

  app.post('/v1/responses', { preHandler: authenticated }, async (request, reply) => {
    const body = responsesRequestSchema.parse(request.body);
    const lifecycle = requestAbortController(request, reply, config.requestTimeoutMs);
    try {
      const result = await queue.enqueue(
        () =>
          provider.generate({
            prompt: serializeResponsesRequest(body),
            signal: lifecycle.controller.signal,
            requestId: request.id,
          }),
        lifecycle.controller.signal,
      );
      const response = mapResponse(result.text);
      store.set({ id: response.id, createdAt: response.created_at, status: 'completed' });
      if (body.stream) {
        return reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache')
          .header('x-tab2api-stream-mode', 'buffered')
          .send(responsesSse(response));
      }
      return response;
    } finally {
      lifecycle.dispose();
    }
  });

  app.post('/admin/session/reset', { preHandler: authenticated }, async () => {
    await provider.reset();
    return {
      status: 'reset',
      detail: 'Browser process closed; dedicated profile data was preserved.',
    };
  });

  app.setErrorHandler((error, request, reply) => {
    let safe: AppError;
    if (error instanceof ZodError) {
      safe = new AppError(
        'invalid_request',
        `Request validation failed: ${error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}`,
      );
    } else if (error instanceof AppError) safe = error;
    else if (error instanceof Error && 'statusCode' in error && error.statusCode === 413) {
      safe = new AppError('invalid_request', 'Request body exceeds TAB2API_BODY_LIMIT_BYTES.');
    } else safe = asSafeAppError(error);
    request.log.warn({ requestId: request.id, code: safe.code }, 'request failed');
    void reply.code(safe.statusCode).send(errorEnvelope(safe));
  });

  app.addHook('onClose', async () => {
    queue.close();
    await provider.close();
  });
  return app;
}
