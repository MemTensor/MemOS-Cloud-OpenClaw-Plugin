import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import plugin from "../index.js";

const createApi = (argv1) => {
  const registeredHooks = [];
  const originalArgv1 = process.argv[1];
  process.argv[1] = argv1;

  const api = {
    config: { hooks: { internal: { enabled: false } } },
    logger: {},
    pluginConfig: {
      apiKey: "mpg-test",
      recallEnabled: false,
      addEnabled: false,
    },
    on: (hookName, handler) => {
      registeredHooks.push({ hookName, handler });
    },
    registerHook: () => {},
  };

  return {
    api,
    registeredHooks,
    restore: () => {
      process.argv[1] = originalArgv1;
    },
  };
};

test("always registers OpenClaw recall on before_prompt_build", async (t) => {
  const hostEntrypoints = [
    {
      name: "versioned host path",
      value:
        "C:\\Users\\example\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\openclaw@2026.4.26\\node_modules\\openclaw\\openclaw.mjs",
    },
    { name: "unversioned host path", value: "/usr/local/bin/openclaw" },
  ];

  for (const hostEntrypoint of hostEntrypoints) {
    await t.test(hostEntrypoint.name, () => {
      const { api, registeredHooks, restore } = createApi(hostEntrypoint.value);
      try {
        plugin.register(api);
      } finally {
        restore();
      }

      assert.ok(registeredHooks.some((hook) => hook.hookName === "before_prompt_build"));
      assert.ok(!registeredHooks.some((hook) => hook.hookName === "before_agent_start"));
    });
  }
});

test("preserves recall for declared legacy host entrypoints", async (t) => {
  const hostEntrypoints = [
    { name: "Moltbot", value: "/usr/local/lib/node_modules/moltbot/moltbot.mjs" },
    { name: "ClawDBot", value: "/usr/local/lib/node_modules/clawdbot/clawdbot.mjs" },
  ];

  for (const hostEntrypoint of hostEntrypoints) {
    await t.test(hostEntrypoint.name, () => {
      const { api, registeredHooks, restore } = createApi(hostEntrypoint.value);
      try {
        plugin.register(api);
      } finally {
        restore();
      }

      assert.ok(registeredHooks.some((hook) => hook.hookName === "before_agent_start"));
      assert.ok(!registeredHooks.some((hook) => hook.hookName === "before_prompt_build"));
    });
  }
});

test("declares the minimum supported OpenClaw plugin API", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.5.7");
});
