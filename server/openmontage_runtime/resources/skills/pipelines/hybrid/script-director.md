# Script Director - Hybrid Pipeline

## 何时使用

这个 stage 将故事映射到 source-led beats 和 support-led beats。你要决定哪里由 source 承载信息，哪里由 support assets 澄清信息。

## Prerequisites

| Layer | Resource | Purpose |
|-------|----------|---------|
| Schema | `schemas/artifacts/script.schema.json` | Artifact validation |
| Prior artifact | `state.artifacts["idea"]["brief"]` | Anchor medium and deliverable mix |
| Tools | `transcriber`, `scene_detect`, `audio_enhance` | Optional source analysis |

## 流程

### 1. 标记 Source-Led 与 Support-Led Beats

对每个 section，说明它是：

- carried by source dialogue or footage,
- carried by narration,
- carried by diagrams or overlays,
- carried by text only.

### 2. 当 Source Speech 更好时使用它，而不是重写

如果 supplied footage 已经包含有力台词，使用 `transcriber` 并保留 authenticity。不要用不必要 narration 替换好的 source material。

### 3. Support 只用于澄清

Support-led beats 应回答：

- what is not visible,
- what needs summarizing,
- what needs emphasis,
- what changes for a different platform.

### 4. 使用 Metadata 表达结构

推荐 metadata keys：

- `anchor_sections`
- `support_sections`
- `narration_sections`
- `required_support_assets`

### 5. Quality Gate

- source-led beats are clearly marked,
- support-led beats are justified,
- the script does not depend on fake or unavailable assets without saying so,
- the structure can produce the intended deliverables.

### Mid-Production Fact Verification

If you encounter uncertainty during script writing:
- Use `web_search` to verify factual claims before committing them to the script
- Use `web_search` to find reference images for visual accuracy
- Log verification in the decision log: `category="visual_accuracy_check"`

script 中每个 factual claim 都应可追溯到 `research_brief`。如果提出 research 中不存在的 claim，先做额外 research 并添加 source。不要编造 statistics、dates 或 attributions。

## Common Pitfalls

- Rewriting strong source dialogue into weaker narration.
- Adding diagrams or cards where the footage already explains the point.
- Hiding unsupported requirements until asset generation.
