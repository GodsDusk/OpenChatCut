# OpenChatCut × OpenMontage 最小验证

本分支用于验证：保留 OpenChatCut 现有聊天、素材和 Proposal 界面，将视频生产智能层切换为服务端 OpenMontage Hybrid Pipeline 后，能否复现 OpenMontage 已验证的内容质量。

## 固定基线

- OpenChatCut：`337471ee9f16a2dfe31f791b1503f444c4adcd21`
- OpenMontage `main`：`b97ad70ff23f9415dc5998569d65959d15df357f`
- Pipeline：`hybrid`
- POC 输出：一条已经合成并验证的 `final.mp4`

迁入的 Prompt、Pipeline、Skill 和 Schema 及其 blob SHA 由 `server/openmontage_runtime/source_manifest.json` 记录。POC 的工具执行桥默认连接当前工作区相邻、同样固定到上述 commit 的 `modify_motage_open`；部署时必须通过 `OPENMONTAGE_SOURCE_ROOT` 指向私有 Worker 镜像内的固定版本，而不是浏览器或用户目录。

## 运行边界

```text
现有 ChatPanel
  -> POST /api/agent/runs（文字、projectId、assetId、baseRevision）
  -> OpenChatCut Node BFF（工程版本、素材归属和同源校验）
  -> 私有 OpenMontage Runtime
  -> idea -> script -> scene_plan -> assets -> edit -> compose
  -> Reviewer / Checkpoint / 人工阶段确认
  -> final.mp4
  -> BFF 校验并发布为 OpenChatCut Asset
  -> SSE editor.proposal
  -> 现有 Proposal UI Apply
```

浏览器只允许获得公开 DTO：消息、阶段、工具名称、审批摘要、产物摘要和最终素材描述。完整 Prompt、Skill 正文、工具 schema、模型凭据、素材真实路径和内部日志必须留在服务端。

## POC 范围

本轮包含：

- Hybrid 六阶段编排与按阶段 Skill 加载；
- 结构化 Artifact 校验、Reviewer、Checkpoint、跨审批子进程恢复和审批；
- 服务端素材解析与隔离 Run workspace；
- 服务端模型调用和固定工具 allowlist；
- 从固定 OpenMontage Source 读取真实 Tool Contract，并在私有子进程执行；
- 最终 MP4 的 ffprobe 验证与 OpenChatCut Proposal 适配；
- SSE 断线续传、取消和幂等边界；
- 构建后浏览器敏感内容扫描。

本轮不包含：

- 多租户身份、计费和跨实例调度；
- 全部 OpenMontage Pipelines 和 Providers；
- 将 `edit_decisions` 映射为 OpenChatCut 多轨可编辑工程；
- Publish 阶段；
- 公网生产部署。
- 完整的 Provider 成本预估和逐工具付费确认。

## 服务端配置

至少配置：

```text
OPENMONTAGE_PYTHON=/path/to/python
OPENMONTAGE_MODEL_BASE_URL=https://provider.example/v1
OPENMONTAGE_MODEL_API_KEY=...
OPENMONTAGE_MODEL_NAME=...
OPENMONTAGE_SOURCE_ROOT=/private/worker/OpenMontage
OPENMONTAGE_SOURCE_COMMIT=b97ad70ff23f9415dc5998569d65959d15df357f
```

`OPENMONTAGE_TOOL_COMMAND` 仅用于替换内置工具桥。完整生成要求 OpenMontage Source 的 Python/FFmpeg/Remotion 依赖及所选 Provider 凭据在服务端可用；缺失时 Runtime 会在创建任务后返回明确的配置错误，不会降级到浏览器 Agent。

## 质量验证

代码验证只能证明链路、状态机和安全边界正确，不能代替内容质量验证。应固定至少三组任务和素材，分别运行：

1. 原始 OpenChatCut；
2. 原始 OpenMontage + 原 Vibe IDE Agent；
3. 本分支 OpenChatCut + 服务端 Runtime。

尽量固定模型、Provider、输入和渲染路径，每组重复运行。集成版本需明显优于原始 OpenChatCut，并接近原始 OpenMontage；主观验收目标为至少 4/5 样本无需重做、只需轻调。

## ToC 前置工作

POC 通过后仍必须补齐统一 user/tenant owner、对象存储、队列/Worker、额度和并发控制、审计日志、Prompt/Skill 版本发布、Provider 成本治理以及多实例状态存储，才能公开提供服务。
