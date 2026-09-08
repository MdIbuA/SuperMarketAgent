/**
 * Domain error types for structured error handling.
 * These errors are safe to surface to the agent and ultimately to Telegram users.
 */

export type DomainErrorCode =
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'BELOW_COST_PRICE'
  | 'INVALID_BILL_STATE'
  | 'BILL_NOT_FOUND'
  | 'BILL_ALREADY_FINALIZED'
  | 'BILL_ITEM_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'INVALID_KHATA_OPERATION'
  | 'DUPLICATE_PRODUCT'
  | 'INVALID_QUANTITY'
  | 'INVALID_AMOUNT'
  | 'CONCURRENCY_CONFLICT'
  | 'PREFERENCE_NOT_FOUND'
  | 'AMBIGUOUS_PRODUCT'
  | 'NO_ACTIVE_BILL'
  | 'VALIDATION_ERROR';

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  toToolResult() {
    return {
      success: false as const,
      errorCode: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export interface ToolSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface ToolFailure {
  success: false;
  errorCode: DomainErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export function toolSuccess<T>(data: T): ToolSuccess<T> {
  return { success: true, data };
}

export function toolFailure(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}): ToolFailure {
  return {
    success: false,
    errorCode: code,
    message,
    details,
  };
}

/**
 * Execute a transaction or async operation with retry on serialization/deadlock failure (e.g. Postgres 40001).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 4,
  delayMs = 40
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isRetryable =
        err?.code === '40001' ||
        err?.message?.includes('could not serialize access') ||
        err?.message?.includes('deadlock detected') ||
        err?.meta?.code === '40001';
      if (isRetryable && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}
