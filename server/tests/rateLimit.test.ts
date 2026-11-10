import { describe, expect, it } from "vitest";
import { createRoleRequestLimiter } from "../src/http/rateLimit.js";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

describe("role-request rate limit", () => {
  it("allows five submissions an hour and thirty a day for one account", () => {
    let clock = 1_000_000;
    const hourly = createRoleRequestLimiter({ now: () => clock, accountPerDay: 100, addressPerHour: 100 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(hourly.consume("account-a", "203.0.113.4").allowed).toBe(true);
    }
    const blocked = hourly.consume("account-a", "203.0.113.4");
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(hourly.consume("account-b", "203.0.113.4").allowed).toBe(true);
    clock += hour;
    expect(hourly.consume("account-a", "203.0.113.4").allowed).toBe(true);

    clock = 1_000_000;
    const daily = createRoleRequestLimiter({ now: () => clock, accountPerHour: 100, addressPerHour: 100 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(daily.consume("account-a", "203.0.113.5").allowed).toBe(true);
    }
    expect(daily.consume("account-a", "203.0.113.5").allowed).toBe(false);
    clock += day;
    expect(daily.consume("account-a", "203.0.113.5").allowed).toBe(true);
  });

  it("limits one client address without naming an account", () => {
    let clock = 0;
    const limiter = createRoleRequestLimiter({ now: () => clock, accountPerHour: 100, accountPerDay: 100 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter.consume(`account-${attempt}`, "198.51.100.8").allowed).toBe(true);
    }
    const blocked = limiter.consume("account-other", "198.51.100.8");
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(JSON.stringify(blocked)).not.toContain("account-");
    clock += hour;
    expect(limiter.consume("account-other", "198.51.100.8").allowed).toBe(true);
  });
});
