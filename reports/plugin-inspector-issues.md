# OpenClaw Plugin Issue Findings

Generated: deterministic
Status: PASS

## Triage Summary

| Metric               | Value |
| -------------------- | ----- |
| Issue findings       | 3     |
| P0                   | 0     |
| P1                   | 2     |
| Live issues          | 0     |
| Live P0 issues       | 0     |
| Compat gaps          | 0     |
| Deprecation warnings | 1     |
| Inspector gaps       | 2     |
| Upstream metadata    | 0     |
| Contract probes      | 3     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                         |
| ------------------- | ----- | -- | --------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam. |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                          |
| deprecation-warning | 1     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                |
| inspector-gap       | 2     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments.                        |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.        |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                           |

## P0 Live Issues

_none_

## Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

- P2 **memos-cloud-openclaw-plugin** `deprecation-warning` `core-compat-adapter`
  - **legacy-before-agent-start**: memos-cloud-openclaw-plugin: legacy before_agent_start hook compatibility is still used
  - state: open · compat:deprecated · deprecated
  - evidence:
    - before_agent_start @ index.js:481

## Inspector Proof Gaps

- P1 **memos-cloud-openclaw-plugin** `inspector-gap` `inspector-follow-up`
  - **conversation-access-hook**: memos-cloud-openclaw-plugin: conversation-access hooks need privacy-boundary probes
  - state: open · compat:none
  - evidence:
    - agent_end @ index.js:515

- P1 **memos-cloud-openclaw-plugin** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: memos-cloud-openclaw-plugin: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerHook @ index.js:467

## Upstream Metadata Issues

_none_

## Issues

- P1 **memos-cloud-openclaw-plugin** `inspector-gap` `inspector-follow-up`
  - **conversation-access-hook**: memos-cloud-openclaw-plugin: conversation-access hooks need privacy-boundary probes
  - state: open · compat:none
  - evidence:
    - agent_end @ index.js:515

- P1 **memos-cloud-openclaw-plugin** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: memos-cloud-openclaw-plugin: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerHook @ index.js:467

- P2 **memos-cloud-openclaw-plugin** `deprecation-warning` `core-compat-adapter`
  - **legacy-before-agent-start**: memos-cloud-openclaw-plugin: legacy before_agent_start hook compatibility is still used
  - state: open · compat:deprecated · deprecated
  - evidence:
    - before_agent_start @ index.js:481

## Contract Probe Backlog

- P1 **memos-cloud-openclaw-plugin** `inspector-capture-api`
  - contract: External inspector capture records service, route, gateway, command, and interactive registrations.
  - id: `api.capture.runtime-registrars:memos-cloud-openclaw-plugin`
  - evidence:
    - registerHook @ index.js:467

- P1 **memos-cloud-openclaw-plugin** `hook-runner`
  - contract: LLM observer hooks receive documented prompt/output fields with expected redaction behavior.
  - id: `hook.llm-observer.privacy-payload:memos-cloud-openclaw-plugin`
  - evidence:
    - agent_end @ index.js:515

- P2 **memos-cloud-openclaw-plugin** `hook-runner`
  - contract: Legacy before_agent_start remains wired until plugins migrate to before_model_resolve and before_prompt_build.
  - id: `hook.compat.before-agent-start-migration:memos-cloud-openclaw-plugin`
  - evidence:
    - before_agent_start @ index.js:481
