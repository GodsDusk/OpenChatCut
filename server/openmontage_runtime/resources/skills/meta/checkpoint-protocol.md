# Checkpoint Protocol — Meta Skill

## 何时使用

在完成某个 stage 的工作并通过 review 后使用。本 skill 教你何时以及如何 checkpoint，以及何时向人类请求 approval。它用指令驱动协议替代 Python `checkpoint_policy.py`。

Checkpoints 是 pipeline 的保存点。它们支持失败后恢复、人类监督和审计链路。

## 协议

### Step 1：检查 Manifest Policy

从 pipeline manifest 读取当前 stage 配置：

```yaml
- name: idea
  checkpoint_required: true      # Must we checkpoint?
  human_approval_default: true   # Must we ask the human?
```

| `checkpoint_required` | `human_approval_default` | 动作 |
|----------------------|------------------------|--------|
| true | true | Checkpoint + 提交给人类审批 |
| true | false | Checkpoint + 自动继续 |
| false | * | 完全跳过 checkpoint（少见） |

### Step 2：准备 Checkpoint Data

收集 checkpoint 所需的一切：

1. **Stage name**：刚完成的是哪个 stage
2. **Status**：`"completed"`（如果需要 approval，则为 `"awaiting_human"`）
3. **Artifacts**：该 stage 产出的 canonical artifact(s)
4. **Metadata**：review findings、cost snapshot、timing info

### Step 3：写入 Checkpoint

调用 checkpoint utility：

```python
write_checkpoint(
    pipeline_dir,      # 项目工作目录
    project_name,      # 项目标识符
    stage_name,        # e.g., "idea"
    status,            # "completed" or "awaiting_human"
    artifacts,         # {"brief": {...}} — stage 输出
)
```

checkpoint utility 会：
- 根据 schema 校验 artifact
- 将 checkpoint JSON 写入磁盘
- 包含 timestamp 和 stage metadata

### Step 4：Stage 内 Checkpointing（恢复支持）

长耗时 stages（如 `assets` 或 `compose` loops）可能因 API 错误、限流或会话中断而中途失败。为了能从精确失败点恢复（例如 Scene 4）：

1. **写入 partial progress**：每次成功生成重要项目（例如一个场景的 assets、一个 clip）时，写入 `in_progress` checkpoint。

   `in_progress` checkpoints 可以省略该 stage 的 canonical artifact，但任何存放在已知 artifact 名称下的数据仍会被 schema 校验。如果 partial data 还不是有效 canonical artifact，将其存放在 `metadata.partial_progress`，而不是 `artifacts`。
   ```python
   write_checkpoint(
       pipeline_dir, project_name,
       stage="assets",
       status="in_progress",
       artifacts={},  # 还没有未完成的 canonical artifact
       metadata={
           "partial_progress": {
               "asset_manifest_draft": partial_manifest_dict,
               "completed_scene_ids": completed_scene_ids,
           }
       },
   )
   ```
   如果 partial artifact 已经满足 schema（例如包含 `version: "1.0"` 和有效 `assets[]` 条目的 `asset_manifest`），可以直接存入 `artifacts`。
2. **从 partial progress 恢复**：启动某个 stage 时，始终检查是否存在对应的 `in_progress` checkpoint。处理方式见 Step 7（Resume Protocol）。

### Step 5：人工 Approval（如需要）

当 `human_approval_default: true` 时：

1. **向人类展示摘要**：
   ```
   ## Stage 完成：[stage_name]

   ### Artifact Summary
   [artifact 关键细节：标题、时长、关键决策]

   ### Review Findings
   [reviewer 摘要：N 个 critical（均已修复）、N 个 suggestions]

   ### 当前成本
   [已花费预算 / 总预算，按工具拆分]

   ### Action Required
   请审阅并批准继续，或提供修改反馈。
   ```

2. **等待人类响应：**
   - **Approved** → 将 checkpoint status 更新为 `"completed"`，进入下一阶段
   - **Revision requested** → 带着人类反馈回到 stage director skill，产出修订 artifacts，重新 review，重新 checkpoint
   - **Abort** → 停止 pipeline

3. **Approval stages**（通常需要人工 approval 的 stages）：
   - `idea`：始终需要。创意方向定义后续一切。
   - `script`：始终需要。文字是基础。
   - `scene_plan`：通常需要。视觉选择具有主观性。
   - `assets`：很少需要。自动质量检查通常足够。
   - `edit`：很少需要。技术组装，不是创意。
   - `compose`：很少需要。但人类可能希望预览。
   - `publish`：始终需要。公开发布前必须由人类批准。

### Step 6：确定下一 Stage

checkpoint 写入并批准后（如需要）：

```python
next_stage = get_next_stage(pipeline_dir, project_name)
```

这会读取所有现有 checkpoints，并返回下一个需要运行的 stage；如果 pipeline 已完成，则返回 `None`。

### Step 7：恢复协议

任何 pipeline run 开始时（不只是 stage 之后），始终检查已有进度：

```python
next_stage = get_next_stage(pipeline_dir, project_name)
```

如果 `next_stage` 不是第一个 stage：
1. 告知人类：“Found existing progress. Resuming from stage: [next_stage]”
2. **检查 partial progress**：读取 `next_stage` 的 checkpoint：
   ```python
   current_cp = read_checkpoint(pipeline_dir, project_name, next_stage)
   ```
   如果 `current_cp` 存在且 status 是 `"in_progress"`，告知人类你将从 stage 中途恢复。
3. **加载 artifacts**：从 checkpoints 中加载之前的 artifacts 作为上下文。如果从 `"in_progress"` 恢复，先从 `current_cp["artifacts"]` 加载任何 schema-valid partial artifact。如果 partial data 存在于 `current_cp["metadata"]["partial_progress"]`，使用该 draft data 和完成标记（如 `completed_scene_ids`）跳过已完成子任务。
4. **继续**：从下一个成功步骤继续生成，并追加到 partial artifact。

如果存在 status 为 `"awaiting_human"` 的 checkpoint：
1. 告知人类：“Stage [name] is awaiting your approval”
2. 展示 checkpoint data 供 review
3. 等待 approval 后再继续

### Sample Checkpoint（Reference-Driven Productions）

当 production 是 reference-driven（存在 `VideoAnalysisBrief`）时，proposal approval 和 full production 之间还有一个额外 checkpoint：

| Stage | checkpoint_required | human_approval_default | 备注 |
|-------|--------------------|-----------------------|-------|
| `sample` | true | true | 始终需要人工 approval |

sample checkpoint：
1. 展示：已渲染 sample clip（10-15 秒）
2. 成本：sample cost vs. projected full-video cost
3. 动作：approve（→ 进入 script）、revise（→ 重新生成 sample）、abort

sample checkpoint 不是 pipeline stage，而是 proposal stage 内的 sub-checkpoint。它不产出 canonical artifact，而是产出一个 rendered preview clip，存放在 `projects/<name>/assets/sample/sample_v{N}.mp4`。

**展示格式：**
```
## Sample Preview 已就绪

**Sample clip:** [sample_v1.mp4 路径]
- Duration: [X] 秒（hook + 1 个中段场景）
- Voice: [TTS provider + voice name]
- Visuals: [说明：AI images、Remotion animations 等]
- Music: [source]

**Sample cost:** $[X.XX]
**Projected full video cost:** $[X.XX]

这个方向感觉对吗？我可以调整：voice、visual style、pacing、music、colors。
```

## 关键原则

1. **始终 checkpoint 已完成工作。** 即使 `checkpoint_required: false`，如果该 stage 消耗了大量时间或成本，也考虑 checkpoint。丢失工作比多一个磁盘文件更糟。

2. **永远不要跳过 creative stages 的人工 approval。** `idea` 和 `script` 塑造一切。为了省时间而跳过它们，会产出没人想要的视频。

3. **包含 cost snapshots。** 人类在批准昂贵下游 stages（assets、compose）前，应知道已经花了多少、还剩多少。

4. **Checkpoints 支持恢复。** 如果 pipeline 在 `compose` 崩溃，人类可以重启，并从 `compose` 继续，而不是从 `idea` 重来。这就是 checkpoint 的意义。

5. **approval request 要透明。** 不要只展示 artifact，还要展示 review findings、成本和任何顾虑，帮助人类做知情决策。
