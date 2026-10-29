# Live sessions_send regression

This opt-in test runs the installed OpenClaw Gateway, its real sender agent and
`sessions_send` tool, a real receiver model, and the real MemOS service. It never
replaces model or MemOS responses. It is intentionally outside the ordinary
`node --test` suite because it writes synthetic MemOS data and consumes model API
usage.

## Preparation

Build both plugin revisions in separate checkouts. Run the normal OpenClaw package
build in each checkout so `lib/memos-core` exists. Point `basePlugin` and
`candidatePlugin` at their respective `packages/openclaw` directories. Use
the same installed OpenClaw runtime, model and MemOS endpoint for both variants.

Create a configuration JSON with absolute paths (keep it outside Git):

```json
{
  "openclawCli": "/absolute/path/to/node_modules/openclaw/openclaw.mjs",
  "sourceConfig": "/absolute/path/to/.openclaw/openclaw.json",
  "envFiles": ["/absolute/path/to/.openclaw/.env"],
  "modelProvider": "your-configured-provider-id",
  "model": "your-model-id",
  "memoryURL": "https://memos.memtensor.cn/api/openmem/v1",
  "basePlugin": "/absolute/path/to/baseline/packages/openclaw",
  "candidatePlugin": "/absolute/path/to/candidate/packages/openclaw",
  "outputRoot": "/absolute/path/to/live-evidence",
  "repetitions": 2,
  "refs": {
    "baseline": "full-baseline-commit-sha",
    "candidate": "full-candidate-commit-sha"
  }
}
```

`sourceConfig` supplies the selected provider's endpoint, model metadata and API
key. `envFiles` supply `MEMOS_API_KEY`; `${ENV_VAR}` provider keys resolve from
these files or the process environment. Keys are passed in child-process
environment variables and redacted from evidence, not copied into test configs.
The current runner supports OpenAI Chat Completions-compatible model providers.

Run explicitly:

```sh
node packages/openclaw/scripts/live-sessions-send.mjs /absolute/path/to/config.json --live
```

## What it verifies

1. Write a random synthetic fact with a new MemOS `user_id` and `agent_id=receiver`.
   Wait until the exact configured receiver search retrieves its code in settled
   `LongTermMemory`. The fast-path `UserMemory` can be replaced during asynchronous
   extraction, so its initial presence alone is insufficient for a stable seed.
2. For each revision, create an independent state directory, loopback Gateway
   port, test workspaces and freshly copied plugin. Select the built-in OpenClaw
   runtime explicitly. Disable automatic memory writes so test conversation
   outputs cannot feed subsequent recalls.
3. Run an ordinary receiver turn as a positive control. Its real outgoing model
   request must contain the retrieved code.
4. Create an empty receiving session through `sessions.patch`, without a model
   turn or existing conversation history. Ask the real sender model to call
   `sessions_send` with exact JSON tool arguments. The sender prompt contains the
   lookup question and case identifier but never the secret code. Repeat with a
   fresh receiving session each time. Require the native tool arguments to retain
   the identifier and omit the answer.
5. Check native tool observations, the real MemOS search response, and the final
   receiver HTTP request. Preserve the source-provenance envelope and inspect
   system and user messages separately. Record receiver answers as secondary
   evidence rather than treating model output alone as proof of injection.

The model SDK may use an HTTP client independent of `globalThis.fetch`. A local
loopback relay therefore records the final request body bytes and forwards them
unchanged to the real configured provider. Real response chunks are streamed
unchanged back to OpenClaw. The fetch observer separately records real MemOS
requests and responses. The host probe only observes supported hooks and returns
no prompt or tool modifications.

## Evidence and interpretation

`results.json` records each control/cross-session case and distinguishes retrieval
from actual inclusion in the model request. Per-variant `fetch.jsonl` records
wire requests and MemOS responses; `host.jsonl` records native tool calls,
origin, runtime and model output. CLI/Gateway logs and empty-session creation
receipts are retained alongside them. All content is synthetic, but the logs
should still be treated as local test artifacts and excluded from Git.

A successful run with baseline recall present but wire memory absent, and
candidate wire memory present in system context, confirms the regression and
fix on the recorded host version. If the baseline retains memory, the scenario
was not reproduced on that host. Configuration, transport, missing-session or
retrieval failures make the run incomplete, not evidence of memory loss.

The Gateway processes started by this test are stopped on completion. Operator
configurations and installed plugins are not changed. Each run writes only
synthetic data in its unique MemOS user scope; automatic deletion is not attempted.

## Historical host versions

Install each official OpenClaw package and its dependencies in a separate temporary
directory and set `openclawCli` to that package's `openclaw.mjs`. Keep the baseline
plugin revision, provider, model and MemOS endpoint identical across host versions.
The report records the host version and plugin source hashes. Preserve each
runtime's lockfile to identify the exact npm package integrity and dependencies.

Use `"variants": ["baseline"]` to test the existing plugin on a historical host
without requiring the candidate. Omit `expectedBaselineMemory` while exploring;
set it to `"present"` or `"absent"` when verifying an identified version boundary.
Unexpected results remain incomplete and require investigation. The default still
runs the complete baseline/candidate comparison.

For a candidate on an unaffected old host, set `"expectedCandidatePlacement":
"prepend"` in the runner configuration. It defaults to `"system"` for affected
hosts. Both modes require the real recalled code once in the final model request
and the correct receiver answer. This is a test expectation, not a plugin setting.

For a July 2026 host using `agents.list`, add:

```json
{
  "variants": ["baseline"],
  "hostConfigDialect": "agents-list",
  "requireInputProvenance": false,
  "expectedBaselineMemory": "present"
}
```

This dialect only adapts configuration field names and disables automatic
agent-to-agent ping-pong after the native send. It does not patch host code.
Those hosts do not expose `ctx.inputProvenance`; a successful native tool call
and the host-owned origin envelope are still required. Modern hosts retain the
stronger provenance assertions. Correlate output by target session and wire
requests/searches by case identifier, so background replies cannot count as the
next case's evidence.

The version boundary concerns the tested recall-overwrite path, not every possible
memory failure or every older maintenance branch. Source inspection and real host
execution are distinct evidence and should be reported separately.

## Observed boundary on 2026-10-27

The real host runs used baseline plugin commit
`e759679e6a1097033a7618ee809c0d39a1e30f1f`, the same `gpt-4.1` provider and
MemOS endpoint, an ordinary positive control, and two independent empty receiving
sessions per variant. Every listed cross-session case completed a real native
`sessions_send`, and every MemOS search returned the exact test code.

| Official host package | Baseline final model request | Automatic system-context candidate |
| --- | --- | --- |
| `2026.7.1-2` | Memory present, 2/2 | Not run |
| `2026.9.9` | Memory present, 2/2 | Not run |
| `2026.10.1` | Memory present, 2/2 | Not run |
| `2026.10.5-beta.1` | Memory present, 2/2 | Not run |
| `2026.10.2` | Memory absent, 2/2 | Memory present in system context once, 2/2 |
| `2026.10.5` (prior same-day run) | Memory absent, 2/2 | Memory present in system context once, 2/2 |

The first affected stable release for this overwrite path is **2026.10.2**.
The earlier-published `2026.10.5-beta.1` package does not contain this change;
package version strings alone do not establish release chronology.

Official release backport
[`36f6305`](https://github.com/openclaw/openclaw/commit/36f630504df528ad70675238f90e4021cfcea6e0)
(main change `0b9d049`, upstream PR #169238) introduced the restoration of the
stored inter-session envelope as the first model-facing text. Its `text =
firstText` fallback can replace the hook-composed user text, including retrieved
memory. This source difference agrees with the adjacent real 2026.10.1/2026.10.2
results. The initial candidate automatically used system context for host-marked
inter-session input; none of these test configurations set a placement option.

The subsequent version gate restricts system placement to confirmed affected
stable releases `2026.10.2` through `2026.10.7`. Official sources confirm the
overwrite guard across this range; `.2` and `.5` are also verified by real host
runs. Earlier hosts, prereleases, unknown versions and unverified future releases
keep prepend placement. Full host versions are read from `api.runtime.version`
or actual OpenClaw package/store metadata so beta suffixes are not discarded.

Incomplete attempts caused by asynchronous seed extraction, legacy automatic
reply turns, or a sender omitting the test identifier were excluded. Their raw
reports remain in the evidence directory. The 2026.10.5 result reuses the prior
same-day real run, with identical baseline and candidate plugin source hashes.

## Version-gated candidate verification

After adding the confirmed-release gate, real MemOS and model runs verified the
candidate's final HTTP requests and answers, with two fresh receiving sessions
per host:

| Host | Candidate memory placement | Native sends / correct answers |
| --- | --- | --- |
| `2026.10.1` | `prependContext`, no dynamic system memory | 2/2 |
| `2026.10.5-beta.1` | `prependContext`, no dynamic system memory | 2/2 |
| `2026.10.2` | `appendSystemContext`, no dynamic user memory | 2/2 |
| `2026.10.5` | `appendSystemContext`, no dynamic user memory | 2/2 |

All candidate ordinary-chat controls retained prepend placement. Every candidate
wire request contained the recalled code exactly once. The `.2` and `.5`
baselines again lost recall; the beta baseline retained it. The `.1` baseline
reuses the earlier complete same-day run with identical upstream/test source
hashes: new `.1` baseline attempts returned an empty receiver answer or empty
sender responses before a tool call. Those baseline attempts were marked
incomplete and excluded; independently successful candidate variants remain
recorded separately. This verifies injection placement, not a measured change
in provider cache-hit rates. The unit suite passes 74 tests.
