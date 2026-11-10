// This limiter keeps its counts in the current API process.
// It is not sufficient for a deployment that runs more than one API instance.
// A stolen application database credential also bypasses it, because that session does not pass through HTTP.

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  now?: () => number;
  accountPerHour?: number;
  accountPerDay?: number;
  addressPerHour?: number;
}

interface WindowCounter {
  startedAt: number;
  count: number;
}

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

export function createRoleRequestLimiter(options: RateLimitOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const accountPerHour = options.accountPerHour ?? 5;
  const accountPerDay = options.accountPerDay ?? 30;
  const addressPerHour = options.addressPerHour ?? 30;
  const buckets = new Map<string, WindowCounter>();

  function withinLimit(key: string, windowMs: number, limit: number): boolean {
    const current = buckets.get(key);
    const time = now();
    if (!current || time - current.startedAt >= windowMs) return true;
    return current.count < limit;
  }

  function bump(key: string, windowMs: number): void {
    const time = now();
    const current = buckets.get(key);
    if (!current || time - current.startedAt >= windowMs) {
      buckets.set(key, { startedAt: time, count: 1 });
      return;
    }
    current.count += 1;
  }

  return {
    consume(accountKey: string, addressKey: string): RateLimitDecision {
      const accountHour = `account-hour:${accountKey}`;
      const accountDay = `account-day:${accountKey}`;
      const addressHour = `address-hour:${addressKey}`;
      const allowed = withinLimit(accountHour, hourMs, accountPerHour)
        && withinLimit(accountDay, dayMs, accountPerDay)
        && withinLimit(addressHour, hourMs, addressPerHour);
      if (!allowed) return { allowed: false, retryAfterSeconds: 60 };
      bump(accountHour, hourMs);
      bump(accountDay, dayMs);
      bump(addressHour, hourMs);
      return { allowed: true, retryAfterSeconds: 60 };
    },
  };
}

export type RoleRequestLimiter = ReturnType<typeof createRoleRequestLimiter>;
