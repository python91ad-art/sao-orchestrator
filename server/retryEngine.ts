// ==========================================
// RETRY ENGINE — 3 retry strategies + Token Bucket rate limiter
// ==========================================

export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 1000,
  backoffMultiplier = 2
): Promise<T> {
  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  if (baseDelay < 0) {
    throw new Error('baseDelay must be non-negative');
  }

  if (backoffMultiplier < 1) {
    throw new Error('backoffMultiplier must be at least 1');
  }

  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt++;

      if (attempt >= maxAttempts) {
        throw error;
      }

      const delay = Math.round(
        baseDelay * Math.pow(backoffMultiplier, attempt)
      );

      console.log(
        `[ExponentialBackoff] Attempt ${attempt} failed. Retrying in ${delay}ms...`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable code in retry engine');
}

export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 1000
): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw error;
      }
      const rawDelay = baseDelay * Math.pow(2, attempt);
      const jitter = 0.5 + Math.random();
      const delay = Math.floor(rawDelay * jitter);
      console.log(`[JitterBackoff] Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable code in retry engine');
}

export async function retryWithLinearBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delay = 1000
): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw error;
      }
      const currentDelay = delay * attempt;
      console.log(`[LinearBackoff] Attempt ${attempt} failed. Retrying in ${currentDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
    }
  }
  throw new Error('Unreachable code in retry engine');
}

// ==========================================
// TOKEN BUCKET RATE LIMITER
// ==========================================

export class TokenBucket {
  capacity: number;
  refillRatePerSecond: number;
  tokens: number;
  lastRefill: number;

  constructor(capacity: number, refillRatePerSecond: number) {
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const refilled = elapsedSeconds * this.refillRatePerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }

  consume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  async waitForTokens(count = 1, maxWaitMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this.consume(count)) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
}

// Global rate limiter for external API calls (100 capacity, 10/sec refill)
export const apiRateLimiter = new TokenBucket(100, 10);

// Secondary rate limiter for AI model calls (lower capacity)
export const aiRateLimiter = new TokenBucket(20, 5);
