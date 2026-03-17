# Feishu Message Sanitization Plan

## Background

The current plugin is intentionally minimal:
- Recall memory before each run
- Add messages after each run

In Feishu/OpenClaw chat surfaces, raw message content may include transport wrappers such as:
- `System: [timestamp] Feishu...`
- `Conversation info (untrusted metadata)`
- `Sender (untrusted metadata)`
- fenced JSON metadata blocks
- reply tags like `[[reply_to_current]]`

When these wrappers are forwarded directly to `/add/message`, stored memories become noisy and harder to retrieve effectively.

## Goal

Keep the plugin lifecycle behavior unchanged while improving write quality for Feishu conversations.

Target outcome:
- store only human-readable message body text
- remove channel envelope noise
- avoid semantic rewriting in v1
- remain reversible and low-risk

## Non-goals

This change does **not** try to:
- summarize or rewrite user intent
- change recall behavior
- add channel-specific schema or server-side memory transformation
- introduce complex model-based write filtering

## Proposed v1 approach

Add a lightweight sanitization step immediately before building the `/add/message` payload.

### Touch points

Prefer the smallest possible change surface:
- `pickLastTurnMessages()`
- `pickFullSessionMessages()`

These functions already extract user/assistant text before writeback, so they are the safest insertion point.

## Sanitization rules

A helper such as `sanitizeFeishuEnvelope(text)` should:

1. remove MemOS prepend marker leftovers
2. remove leading `System: ... Feishu ...` envelope lines
3. remove `Conversation info (untrusted metadata):` blocks
4. remove `Sender (untrusted metadata):` blocks
5. remove fenced JSON blocks associated with those metadata sections
6. remove reply tags like `[[reply_to_current]]` and `[[reply_to:<id>]]`
7. compress excessive blank lines
8. trim final output

## Safety constraints

To reduce false positives:
- only apply heavy Feishu cleanup when obvious Feishu envelope markers are detected
- keep original text as fallback if sanitized output is empty
- do not alter function signatures or request structure

## Config tightening used alongside v1

Recommended conservative write settings:

```json
{
  "captureStrategy": "last_turn",
  "includeAssistant": false,
  "maxMessageChars": 1200
}
```

Rationale:
- `last_turn` limits exposure to noisy historical wrappers
- `includeAssistant: false` reduces reply-tag/channel-noise propagation
- lower `maxMessageChars` reduces oversized wrapped payloads

## Validation plan

### Case A: Feishu wrapped user message
Input contains:
- `System:` line
- `Conversation info`
- `Sender`
- JSON metadata
- actual user text

Expected stored text:
- only actual user text

### Case B: assistant reply tag
Input contains:
- `[[reply_to_current]] hello`

Expected stored text:
- `hello`

### Case C: plain normal message
Input contains no wrappers.

Expected stored text:
- unchanged original text

## Follow-up ideas

Potential v1.1 / v2 improvements:
- stronger block detection for edge-case wrappers
- optional config flag like `sanitizeFeishuMetadata`
- tests for wrapped chat payloads
- documentation cleanup to reflect actual supported config keys

## Notes

The public README currently describes a minimal lifecycle bridge and does not expose any built-in write-side sanitization option. This plan keeps that philosophy intact while adding a small, practical cleanup layer for Feishu deployments.
