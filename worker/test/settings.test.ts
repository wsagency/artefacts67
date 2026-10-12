import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { openD1Shim } from "./db.js";
import { DEFAULT_RETENTION, openSettings } from "../src/store.js";
import { asCodeError } from "../src/types.js";

test("retention recovers missing and invalid persisted state", async t => {
  const db = openD1Shim();
  t.after(() => db.close());
  const settings = openSettings(db);
  await Effect.runPromise(settings.setRetention(25));
  await db.prepare("DELETE FROM platform_settings").run();
  assert.equal(await Effect.runPromise(settings.retention()), DEFAULT_RETENTION);
  await Effect.runPromise(settings.setRetention(25));
  await db.prepare("UPDATE platform_settings SET retention = 0").run();
  assert.equal(await Effect.runPromise(settings.retention()), DEFAULT_RETENTION);
});

test("retention mutations are lazy and reject invalid boundaries without changing state", async t => {
  const db = openD1Shim();
  t.after(() => db.close());
  const settings = openSettings(db);
  const before = await Effect.runPromise(settings.retention());
  const change = settings.setRetention(25);
  assert.equal(await Effect.runPromise(settings.retention()), before);
  assert.equal(await Effect.runPromise(change), 25);
  assert.equal(await Effect.runPromise(settings.retention()), 25);
  assert.equal(await Effect.runPromise(settings.setRetention(1)), 1);
  assert.equal(await Effect.runPromise(settings.retention()), 1);
  for (const bad of [0, -3, 1.5, Number.NaN]) {
    await assert.rejects(() => Effect.runPromise(settings.setRetention(bad)), (error: unknown) =>
      asCodeError(error).code === "invalid-retention" &&
      asCodeError(error).message === "Retention must be a whole number of versions, at least 1.");
  }
  assert.equal(await Effect.runPromise(settings.retention()), 1);
  const caught = await Effect.runPromise(Effect.catch(Effect.as(settings.setRetention(0), "unexpected success"), error => Effect.succeed(error.code)));
  assert.equal(caught, "invalid-retention");
});

test("mail identity validates sender forms and preserves retention and previous sender on failure", async t => {
  const db = openD1Shim();
  t.after(() => db.close());
  const settings = openSettings(db);
  await Effect.runPromise(settings.setRetention(25));
  assert.equal(await Effect.runPromise(settings.setMailFrom("  sender@example.test  ")), "sender@example.test");
  assert.equal(await Effect.runPromise(settings.setMailFrom("Agency <sender@example.test>")), "Agency <sender@example.test>");
  for (const bad of ["sender", "bad@@example.test", "sender@example.test,other@example.test", "sender@example.test\r\nBcc: other@example.test"]) {
    const code = await Effect.runPromise(Effect.catch(Effect.as(settings.setMailFrom(bad), "unexpected success"), error => Effect.succeed(error.code)));
    assert.equal(code, "invalid-mail-from");
    assert.equal(await Effect.runPromise(settings.mailFrom()), "Agency <sender@example.test>");
    assert.equal(await Effect.runPromise(settings.retention()), 25);
  }
  assert.equal(await Effect.runPromise(settings.setMailFrom("")), "");
  assert.equal(await Effect.runPromise(settings.retention()), 25);
});
