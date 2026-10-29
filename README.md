# MemOS Cloud Host Plugins

[English](README.md) | [中文](README_ZH.md)

This pnpm monorepo maintains two MemOS Cloud lifecycle plugins for different hosts. Both plugins automatically recall relevant memories before a turn and add the completed turn back to MemOS Cloud afterward.

## Packages

| Host | npm package | Package guide |
|---|---|---|
| OpenClaw | `@memtensor/memos-cloud-openclaw-plugin` | [`packages/openclaw/README.md`](packages/openclaw/README.md) |
| DeepSeek Harness (DSH) | `@memtensor/memos-cloud-dsh-plugin` | [`packages/dsh/README.md`](packages/dsh/README.md) |

The plugins share the MemOS Cloud API and fail-open behavior, while installation, configuration, compatibility, and host-specific lifecycle details are maintained in their respective package guides.

Choose the guide for your host:

- [OpenClaw package guide](packages/openclaw/README.md)
- [DeepSeek Harness package guide](packages/dsh/README.md)
