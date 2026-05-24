/** Base application error */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code = 'APP_ERROR', statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** AI provider errors (timeout, rate-limit, bad response) */
export class AIError extends AppError {
  public readonly provider: string;
  public readonly model: string;

  constructor(message: string, provider: string, model: string, code = 'AI_ERROR') {
    super(message, code, 502);
    this.name = 'AIError';
    this.provider = provider;
    this.model = model;
  }
}

/** AI routing/configuration errors (missing labels, invalid usage routes) */
export class AIConfigError extends AppError {
  constructor(message: string) {
    super(message, 'AI_CONFIG', 500);
    this.name = 'AIConfigError';
  }
}

/** Queue / BullMQ errors */
export class QueueError extends AppError {
  public readonly queue: string;

  constructor(message: string, queue: string) {
    super(message, 'QUEUE_ERROR', 503);
    this.name = 'QueueError';
    this.queue = queue;
  }
}
