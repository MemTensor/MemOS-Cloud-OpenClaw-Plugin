/**
 * Regression tests for async_mode add/message with empty or non-JSON response bodies.
 *
 * When async_mode is true (the default), the MemOS /add/message endpoint
 * returns HTTP 202 Accepted with an empty body. Previously, callApi called
 * res.json() unconditionally, which threw a SyntaxError on an empty body and
 * caused the agent_end handler to treat the add as failed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.js";
import { addMessage } from "../lib/memos-cloud-api.js";

const createAgentEndHandler = (sessionKey, sessionId, pluginConfig = {}) => {
  const hooks = new Map();
  const logs = [];
  plugin.register({
    config: { hooks: { internal: { enabled: false } } },
    logger: {
      info: (message) => logs.push({ level: "info", message }),
      warn: (message) => logs.push({ level: "warn", message }),
    },
    pluginConfig: {
      apiKey: "mpg-test",
      baseUrl: "http://memos.test",
      recallEnabled: false,
      rumEnabled: false,
      ...pluginConfig,
    },
    on: (name, handler) => hooks.set(name, handler),
    registerHook: () => {},
  });

  return {
    handler: hooks.get("agent_end"),
    ctx: { sessionKey, sessionId },
    logs,
  };
};

test("callApi: HTTP 202 with empty body does not throw", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("", { status: 202, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await addMessage(
      { apiKey: "mpg-test", baseUrl: "http://memos.test", timeoutMs: 1000, retries: 0 },
      { messages: [{ role: "user", content: "hello" }] },
    );
    assert.ok(called, "fetch should have been called");
    assert.deepEqual(result, {}, "empty 202 body should return {}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callApi: HTTP 202 with JSON body returns parsed result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ data: { id: "abc" } }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await addMessage(
      { apiKey: "mpg-test", baseUrl: "http://memos.test", timeoutMs: 1000, retries: 0 },
      { messages: [{ role: "user", content: "hello" }] },
    );
    assert.deepEqual(result, { data: { id: "abc" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callApi: HTTP 200 with non-JSON body does not throw", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
  };

  try {
    const result = await addMessage(
      { apiKey: "mpg-test", baseUrl: "http://memos.test", timeoutMs: 1000, retries: 0 },
      { messages: [{ role: "user", content: "hello" }] },
    );
    assert.deepEqual(result, {}, "non-JSON 200 body should return {}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent_end: async 202 empty response does not log add failed", async () => {
  const originalFetch = globalThis.fetch;
  let adds = 0;
  globalThis.fetch = async (_url) => {
    if (_url.endsWith("/add/message")) adds += 1;
    // Simulate async_mode: true → HTTP 202 empty body
    return new Response("", { status: 202 });
  };

  try {
    const { handler, ctx, logs } = createAgentEndHandler(
      "agent:main:test:async-202",
      "session-async-202",
      { asyncMode: true },
    );

    await handler(
      {
        success: true,
        messages: [
          { role: "user", content: "remember this" },
          { role: "assistant", content: [{ type: "text", text: "noted" }] },
        ],
        runId: "run-async-202",
      },
      ctx,
    );

    assert.equal(adds, 1, "add/message should be called once");
    const warnMessages = logs.filter((l) => l.level === "warn").map((l) => l.message);
    assert.ok(
      !warnMessages.some((m) => m.includes("add failed")),
      `no 'add failed' warning expected, got: ${JSON.stringify(warnMessages)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
