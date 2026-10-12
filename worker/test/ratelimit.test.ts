import test from "node:test";
import assert from "node:assert/strict";

import { decide, type WindowDecision, type RateResult } from "../src/ratelimit.js";
import { rateLimitBinding } from "./doubles.js";

const HOUR = 3_600_000;

test("first hit is allowed and reports remaining", () => {
  const d = decide(undefined, { limit: 4, windowMs: HOUR, now: 1_000 });
  assert.equal(d.allowed, true);
  assert.equal(d.count, 1);
  assert.equal(d.remaining, 3);
  assert.equal(d.retryAfter, 0);
});

test("count over limit is blocked with a retry-after", () => {
  let stored: WindowDecision | undefined;
  const step = (now: number) => {
    stored = decide(stored, { limit: 4, windowMs: HOUR, now });
    return stored;
  };
  step(0);
  step(1);
  step(2);
  step(3); // 4th attempt still allowed (limit inclusive)
  const fifth = step(4);
  assert.equal(fifth.allowed, false);
  assert.equal(fifth.remaining, 0);
  assert.ok(fifth.retryAfter > 0 && fifth.retryAfter <= HOUR / 1000);
});

test("expired window resets the counter", () => {
  let stored = decide(undefined, { limit: 1, windowMs: 1_000, now: 0 });
  assert.equal(stored.allowed, true);

  const again = decide(stored, { limit: 1, windowMs: 1_000, now: 500 });
  assert.equal(again.allowed, false);

  const later = decide(again, { limit: 1, windowMs: 1_000, now: 1_600 });
  assert.equal(later.allowed, true);
  assert.equal(later.count, 1);
});

test("a lockout caller uses limit-1: 4th wrong attempt is the first blocked", () => {
  // Gate semantics (ADR 0014): the counter blocks once the 4th wrong password
  // arrives, so the gate passes limit: 3 to this generic window.
  let stored: WindowDecision | undefined;
  const step = (now: number) => {
    stored = decide(stored, { limit: 3, windowMs: HOUR, now });
    return stored;
  };
  assert.equal(step(0).allowed, true);
  assert.equal(step(1).allowed, true);
  assert.equal(step(2).allowed, true);
  assert.equal(step(3).allowed, false);
});

test("RateLimit Durable Object persists check, hit, and reset state", async () => {
  const binding = rateLimitBinding();
  const call = (body: { op: string; key: string; limit?: number; windowMs?: number }) => binding.get(binding.idFromName("global")).fetch("https://rate-limit/", {
    method: "POST", body: JSON.stringify(body),
  }).then(response => response.json() as Promise<RateResult>);
  const options = { key: "lock:owner@example.test", limit: 3, windowMs: 300_000 };

  assert.deepEqual(await call({ op: "check", ...options }), {
    allowed: true, locked: false, remaining: 3, retryAfter: 0,
  });
  assert.equal((await call({ op: "hit", ...options })).locked, false);
  assert.equal((await call({ op: "hit", ...options })).locked, false);
  const third = await call({ op: "hit", ...options });
  assert.equal(third.allowed, true);
  assert.equal(third.locked, true);
  assert.equal(third.remaining, 0);
  assert.deepEqual(Object.keys(third).sort(), ["allowed", "locked", "remaining", "retryAfter"]);
  assert.ok(third.retryAfter > 0);

  const locked = await call({ op: "check", ...options });
  assert.equal(locked.allowed, false);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfter > 0);

  assert.deepEqual(await call({ op: "reset", key: options.key }), { ok: true });
  assert.equal((await call({ op: "check", ...options })).locked, false);
});

test("counter expiry uses the window end, not the most recent hit", async () => {
  const binding = rateLimitBinding();
  const start = Date.now() - 20000;
  binding.values.set("w:runtime-ip:test", { count: 1, windowStart: start });
  const response = await binding.get("global").fetch("https://rate-limit/", {
    method: "POST", body: JSON.stringify({ op: "hit", key: "runtime-ip:test", limit: 180, windowMs: 60000 }),
  });
  assert.equal((await response.json<RateResult>()).allowed, true);
  assert.equal(binding.values.get("w:runtime-ip:test")?.expiresAt, start + 60000);
  assert.equal(binding.alarmAt, start + 60000);
});

test("expiry sweeps bounded pages and retain active lockouts and unknown legacy windows", async () => {
  const binding = rateLimitBinding();
  const now = Date.now();
  for (let i = 0; i < 260; i++) binding.values.set(`w:expired:${String(i).padStart(3, "0")}`, {
    count: 1, windowStart: now - HOUR, expiresAt: now - 1000,
  });
  binding.values.set("w:gate:active", { count: 4, windowStart: now - 10000, expiresAt: now + HOUR });
  binding.values.set("w:legacy:unknown", { count: 4, windowStart: now - 7 * HOUR });
  await binding.fireAlarm();
  assert.equal([...binding.values.keys()].filter((key) => key.startsWith("w:expired:")).length, 132);
  await binding.fireAlarm();
  await binding.fireAlarm();
  assert.equal([...binding.values.keys()].filter((key) => key.startsWith("w:expired:")).length, 0);
  assert.equal(binding.values.get("w:gate:active")?.count, 4);
  assert.equal(binding.values.get("w:legacy:unknown")?.count, 4);
  assert.ok(binding.alarmAt !== null && binding.alarmAt >= now + HOUR);
});

test("checking a legacy lockout learns its duration without releasing it early", async () => {
  const binding = rateLimitBinding();
  const start = Date.now() - 10000;
  binding.values.set("w:gate:legacy", { count: 4, windowStart: start });
  const response = await binding.get("global").fetch("https://rate-limit/", {
    method: "POST", body: JSON.stringify({ op: "check", key: "gate:legacy", limit: 4, windowMs: HOUR }),
  });
  assert.equal((await response.json<RateResult>()).locked, true);
  assert.equal(binding.values.get("w:gate:legacy")?.expiresAt, start + HOUR);
  await binding.fireAlarm();
  assert.equal(binding.values.get("w:gate:legacy")?.count, 4);
  binding.values.set("w:gate:legacy", { count: 4, windowStart: start, expiresAt: Date.now() - 1 });
  await binding.fireAlarm();
  assert.equal(binding.values.has("w:gate:legacy"), false);
  assert.equal(binding.alarmAt, null);
});

test("a checked lockout with an increased duration is not swept at the former deadline", async () => {
  const binding = rateLimitBinding();
  const start = Date.now() - 120000;
  binding.values.set("w:gate:changed", { count: 4, windowStart: start, expiresAt: start + 60000 });
  const response = await binding.get("global").fetch("https://rate-limit/", {
    method: "POST", body: JSON.stringify({ op: "check", key: "gate:changed", limit: 4, windowMs: HOUR }),
  });
  assert.equal((await response.json<RateResult>()).locked, true);
  await binding.fireAlarm();
  assert.equal(binding.values.get("w:gate:changed")?.expiresAt, start + HOUR);
});
