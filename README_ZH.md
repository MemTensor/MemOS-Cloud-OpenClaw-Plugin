# MemOS Cloud 宿主插件

[English](README.md) | [中文](README_ZH.md)

本 pnpm monorepo 维护面向不同宿主的两个 MemOS Cloud 生命周期插件。两个插件都会在回合开始前自动召回相关记忆，并在回合完成后将本轮消息写回 MemOS Cloud。

## 插件

| 宿主 | npm 包 | 插件文档 |
|---|---|---|
| OpenClaw | `@memtensor/memos-cloud-openclaw-plugin` | [`packages/openclaw/README_ZH.md`](packages/openclaw/README_ZH.md) |
| DeepSeek Harness（DSH） | `@memtensor/memos-cloud-dsh-plugin` | [`packages/dsh/README.zh.md`](packages/dsh/README.zh.md) |

两个插件共用 MemOS Cloud API 和 fail-open 行为；安装、配置、兼容性及宿主专属生命周期细节请以各自 package 文档为准。

请选择对应宿主的文档：

- [OpenClaw 插件文档](packages/openclaw/README_ZH.md)
- [DeepSeek Harness 插件文档](packages/dsh/README.zh.md)
