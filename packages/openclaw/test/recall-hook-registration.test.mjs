import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import plugin from "../index.js";
import { detectHostRuntime } from "../lib/host-runtime.js";

const createApi = (entrypoint, pluginConfig = {}, runtime) => {
  const registeredHooks = [];
  const originalArgv1 = process.argv[1];
  process.argv[1] = entrypoint;

  const api = {
    version: "0.1.21-beta.0", // Plugin version, never the host version.
    runtime,
    config: { hooks: { internal: { enabled: false } } },
    logger: {},
    pluginConfig: {
      apiKey: "mpg-test",
      recallEnabled: false,
      addEnabled: false,
      rumEnabled: false,
      ...pluginConfig,
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

function registerAt(entrypoint, pluginConfig, runtime) {
  const { api, registeredHooks, restore } = createApi(entrypoint, pluginConfig, runtime);
  try {
    plugin.register(api);
  } finally {
    restore();
  }

  return registeredHooks;
}

function assertRecallHook(entrypoint, expected, runtime) {
  const hooks = registerAt(entrypoint, undefined, runtime);
  const recallHooks = hooks.filter(({ hookName }) =>
    ["before_prompt_build", "before_agent_start"].includes(hookName),
  );
  assert.deepEqual(recallHooks.map(({ hookName }) => hookName), [expected]);
  assert.equal(hooks.filter(({ hookName }) => hookName === "agent_end").length, 1);
}

function hostFixture(t, name, version, entry = "bin/cli.mjs") {
  const root = mkdtempSync(join(tmpdir(), "memos-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  const entrypoint = join(root, entry);
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "");
  return { root, entrypoint };
}

test("registers exactly one recall hook for versioned and unversioned host entrypoints", async (t) => {
  const cases = [
    ["modern Windows OpenClaw", String.raw`C:\Users\lee\pnpm\openclaw@2026.5.7\node_modules\openclaw\openclaw.mjs`, "before_prompt_build"],
    ["older OpenClaw", "/opt/pnpm/openclaw@2026.2.15/node_modules/openclaw/openclaw.mjs", "before_agent_start"],
    ["first prompt-build release remains below the migration boundary", "/opt/pnpm/openclaw@2026.2.17/node_modules/openclaw/openclaw.mjs", "before_agent_start"],
    ["older OpenClaw with prompt-build support retains the legacy hook", "/opt/pnpm/openclaw@2026.4.26/node_modules/openclaw/openclaw.mjs", "before_agent_start"],
    ["version immediately below the migration boundary", "/opt/pnpm/openclaw@2026.5.6/node_modules/openclaw/openclaw.mjs", "before_agent_start"],
    ["unversioned OpenClaw", "/memos-test-no-package/bin/openclaw", "before_prompt_build"],
    ["unversioned Windows OpenClaw", String.raw`C:\memos-test-no-package\bin\openclaw.cmd`, "before_prompt_build"],
    ["Moltbot username", "/home/moltbot/pnpm/openclaw@2026.7.29/node_modules/openclaw/openclaw.mjs", "before_prompt_build"],
    ["ClawDBot parent directory", "/srv/clawdbot/openclaw.mjs", "before_prompt_build"],
    ["legacy names in Windows directories", String.raw`C:\Users\moltbot\clawdbot\openclaw@2026.7.29\node_modules\openclaw\openclaw.mjs`, "before_prompt_build"],
    ["unrelated version in parent directory", "/opt/helper@1.2.3/pnpm/openclaw@2026.7.29/node_modules/openclaw/openclaw.mjs", "before_prompt_build"],
    ["versioned development build", "/opt/openclaw@2026.5.8-dev.1/node_modules/openclaw/openclaw.mjs", "before_prompt_build"],
    ["unversioned Moltbot", "/opt/node_modules/moltbot/moltbot.mjs", "before_agent_start"],
    ["Moltbot generic entrypoint", "/opt/node_modules/moltbot/bin/cli.js", "before_agent_start"],
    ["unversioned ClawDBot", "/opt/node_modules/clawdbot/clawdbot.mjs", "before_agent_start"],
    ["Windows ClawDBot shim", String.raw`C:\tools\clawdbot.cmd`, "before_agent_start"],
    ["versioned legacy host", "/opt/moltbot@2026.7.29/node_modules/moltbot/moltbot.mjs", "before_agent_start"],
  ];
  for (const [name, entrypoint, expected] of cases) {
    await t.test(name, () => assertRecallHook(entrypoint, expected));
  }
});

test("does not mistake a compatibility harness package version for the host version", (t) => {
  const { entrypoint } = hostFixture(t, "compatibility-harness", "0.1.0", "bin/openclaw.mjs");
  assertRecallHook(entrypoint, "before_prompt_build");
});

test("treats an unparseable development host version as unknown", (t) => {
  const { entrypoint } = hostFixture(t, "openclaw", "development");
  assertRecallHook(entrypoint, "before_prompt_build");
});

test("preserves older OpenClaw compatibility using the host package version", (t) => {
  const { entrypoint } = hostFixture(t, "openclaw", "2026.2.15");
  assertRecallHook(entrypoint, "before_agent_start");
});

test("recognizes a development host package with a numeric release version", (t) => {
  const { entrypoint } = hostFixture(t, "openclaw", "2026.5.8-dev.1+build.2");
  assertRecallHook(entrypoint, "before_prompt_build");
});

test("recognizes a legacy host from its package even with a generic entrypoint", (t) => {
  const { entrypoint } = hostFixture(t, "moltbot", "2026.7.29");
  assertRecallHook(entrypoint, "before_agent_start");
});

test("uses the injected runtime version before any entrypoint hints", async (t) => {
  const cases = [
    ["wrapper entrypoint", "/memos-test-no-package/compatibility-runner.mjs", "2026.10.7", "before_prompt_build"],
    ["old path with a modern runtime", "/opt/openclaw@2026.2.15/node_modules/openclaw/openclaw.mjs", "2026.10.7", "before_prompt_build"],
    ["modern path with an old runtime", "/opt/openclaw@2026.10.7/node_modules/openclaw/openclaw.mjs", "2026.2.15", "before_agent_start"],
    ["legacy-named entrypoint with a modern runtime", "/opt/node_modules/clawdbot/clawdbot.mjs", "2026.10.7", "before_prompt_build"],
    ["Clawdbot runtime behind an OpenClaw entrypoint", "/memos-test-no-package/openclaw.mjs", "2026.1.24-3", "before_agent_start"],
    ["Moltbot runtime behind an OpenClaw entrypoint", "/memos-test-no-package/openclaw.mjs", "2026.1.27-beta.1", "before_agent_start"],
    ["runtime below the migration boundary", "/memos-test-no-package/openclaw.mjs", "2026.5.6", "before_agent_start"],
    ["runtime at the migration boundary", "/memos-test-no-package/openclaw.mjs", "2026.5.7", "before_prompt_build"],
    ["development build at the migration boundary", "/memos-test-no-package/openclaw.mjs", "2026.5.7-dev.1+build.2", "before_prompt_build"],
  ];
  for (const [name, entrypoint, version, expected] of cases) {
    await t.test(name, () => assertRecallHook(entrypoint, expected, { version }));
  }
});

test("does not use a conflicting host package version when the API provides one", (t) => {
  const { entrypoint } = hostFixture(t, "openclaw", "2026.2.15");
  assertRecallHook(entrypoint, "before_prompt_build", { version: "2026.10.7" });
});

test("falls back when the runtime version is missing or unusable", async (t) => {
  for (const version of [undefined, null, 42, "", "unknown", "development", "0.0.0"]) {
    await t.test(String(version), () => {
      assertRecallHook("/opt/openclaw@2026.2.15/node_modules/openclaw/openclaw.mjs", "before_agent_start", { version });
      assertRecallHook("/opt/openclaw@2026.10.7/node_modules/openclaw/openclaw.mjs", "before_prompt_build", { version });
    });
  }
});

test("falls back when metadata-only runtime access throws", () => {
  const runtime = new Proxy({}, {
    get() { throw new Error("Runtime unavailable during setup-only registration"); },
  });
  assertRecallHook("/opt/openclaw@2026.2.15/node_modules/openclaw/openclaw.mjs", "before_agent_start", runtime);
});

test("does not treat placeholder metadata as a known old host version", (t) => {
  const { entrypoint } = hostFixture(t, "openclaw", "0.0.0");
  assertRecallHook(entrypoint, "before_prompt_build", { version: "0.0.0" });
  assertRecallHook("/opt/openclaw@0.0.0/node_modules/openclaw/openclaw.mjs", "before_prompt_build", { version: "0.0.0" });
});

test("resolves a legacy-named CLI symlink to the actual OpenClaw package", (t) => {
  const { root, entrypoint } = hostFixture(t, "openclaw", "2026.7.29");
  const alias = join(root, "moltbot");
  try {
    symlinkSync(entrypoint, alias);
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Creating file symlinks requires Windows developer mode or administrator privileges");
      return;
    }
    throw error;
  }
  assertRecallHook(alias, "before_prompt_build");
});

test("preserves version precedence across versioned symlink entrypoints", async (t) => {
  const cases = [
    ["missing target version", undefined, "2026.2.15", "before_agent_start"],
    ["unparseable target version", "development", "2026.2.15", "before_agent_start"],
    ["placeholder target version", "0.0.0", "2026.2.15", "before_agent_start"],
    ["valid target version overrides a stale symlink path", "2026.10.7", "2026.10.7", "before_prompt_build"],
  ];
  for (const [name, metadataVersion, expectedVersion, expectedHook] of cases) {
    await t.test(name, (subtest) => {
      const { root, entrypoint } = hostFixture(subtest, "openclaw", metadataVersion);
      const alias = join(root, "store", "openclaw@2026.2.15", "node_modules", "openclaw", "openclaw.mjs");
      mkdirSync(dirname(alias), { recursive: true });
      try {
        symlinkSync(entrypoint, alias);
      } catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
          subtest.skip("Creating file symlinks requires Windows developer mode or administrator privileges");
          return;
        }
        throw error;
      }
      assert.deepEqual(detectHostRuntime({ scriptPath: alias }), { id: "openclaw", version: expectedVersion });
      assertRecallHook(alias, expectedHook, { version: "unknown" });
      assertRecallHook(alias, "before_prompt_build", { version: "2026.10.7" });
    });
  }
});

test("both recall hooks retrieve memory once and return prompt context", async (t) => {
  for (const entrypoint of ["/memos-test-no-package/bin/openclaw", "/opt/node_modules/moltbot/moltbot.mjs"]) {
    await t.test(entrypoint, async (subtest) => {
      const requests = [];
      subtest.mock.method(globalThis, "fetch", async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ data: {
          memory_detail_list: [{ memory_value: "The user uses macOS.", relativity: 1 }],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      const hooks = registerAt(entrypoint, { recallEnabled: true, baseUrl: "http://memos.test" });
      const recall = hooks.filter(({ hookName }) => ["before_prompt_build", "before_agent_start"].includes(hookName));
      assert.equal(recall.length, 1);
      const result = await recall[0].handler({ prompt: "How do I install this tool?" }, { sessionKey: "agent:main:test:recall" });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "http://memos.test/search/memory");
      assert.equal(requests[0].body.query, "How do I install this tool?");
      assert.match(result.prependContext, /The user uses macOS\./);
      assert.match(result.appendSystemContext, /Memory Safety/);
    });
  }
});
