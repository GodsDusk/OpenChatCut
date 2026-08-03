# Edit Director - Hybrid Pipeline

## 何时使用

这个 stage 为 source-led video 创建带 support elements 的 layered edit logic。顺序很重要：anchor cut 在前，support layers 在后。

## Prerequisites

| Layer | Resource | Purpose |
|-------|----------|---------|
| Schema | `schemas/artifacts/edit_decisions.schema.json` | Artifact validation |
| Prior artifacts | `state.artifacts["assets"]["asset_manifest"]`, `state.artifacts["scene_plan"]["scene_plan"]`, `state.artifacts["script"]["script"]` | Source/support assets and timeline intent |
| Playbook | Active style playbook | Typography and motion consistency |

## 流程

### 1. 先锁定 Anchor Cut

在添加 support overlays 前，viewer 应该已经能理解故事。如果 anchor cut 很弱，support layers 救不了它。

### 2. 按优先级添加 Support

典型顺序：

1. subtitles,
2. speaker or context labels,
3. diagrams or stat cards,
4. optional inserts,
5. CTA elements.

### 3. 保护 Readability

不要在同一时刻堆叠过多 support layers。如果 subtitles、labels、charts 和 overlays 冲突，简化。

### 4. 使用 Metadata 表达 Layering Logic

推荐 metadata keys：

- `anchor_cut_notes`
- `layer_order`
- `overlay_windows`
- `variant_edit_rules`

### 5. Quality Gate

- the anchor cut works on its own,
- support layers clarify instead of distract,
- mobile readability survives,
- variants remain consistent.

## Common Pitfalls

- Trying to fix a weak cut with extra graphics.
- Letting support layers compete with the source.
- Building each platform variant as a separate editorial philosophy.
