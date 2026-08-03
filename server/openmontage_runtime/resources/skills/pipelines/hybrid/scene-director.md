# Scene Director - Hybrid Pipeline

## 何时使用

你负责将 hybrid structure 转成 visual system，确保 source 可见，并让 support layers 保持受控。

## Prerequisites

| Layer | Resource | Purpose |
|-------|----------|---------|
| Schema | `schemas/artifacts/scene_plan.schema.json` | Artifact validation |
| Prior artifacts | `state.artifacts["script"]["script"]`, `state.artifacts["idea"]["brief"]` | Hybrid structure and source truth |
| Tools | `frame_sampler`, `scene_detect` | Optional source inspection |
| Playbook | Active style playbook | Layout consistency |

## 流程

### 1. 保持 Anchor Medium 可见

如果作品是 source-led，source 必须在 scene plan 中保持视觉主导。不要用持续 overlays 遮住 anchor。

### 2. 只把 Support 留给明确职责

support scenes 用于：

- chapter transitions,
- clarifying diagrams,
- stat emphasis,
- CTA or summary moments,
- gap-filling inserts.

### 3. 规划 Variant Safety

如果项目需要 multiple aspect ratios，定义以下位置：

- subtitles live,
- speaker labels live,
- chart or code safe zones live,
- crop-sensitive source media becomes unsafe.

### 4. 使用 Metadata 表达 Balance Rules

推荐 metadata keys：

- `anchor_rules`
- `support_rules`
- `safe_zones`
- `variant_rules`
- `overlay_density_limits`

### 5. Quality Gate

- the anchor medium stays primary where intended,
- support layers are limited and purposeful,
- aspect-ratio planning is explicit,
- no scene relies on invisible future magic.

## Common Pitfalls

- Turning source-led scenes into overlay soup.
- Forgetting variant-safe zones until compose.
- Using generated inserts for every transition.
