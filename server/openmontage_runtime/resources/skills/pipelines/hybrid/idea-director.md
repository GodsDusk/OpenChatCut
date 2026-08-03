# Idea Director - Hybrid Pipeline

## 何时使用

当项目将 real source media 与 support visuals 结合时使用本 pipeline：interviews plus diagrams、footage plus overlays、screen recording plus branded graphics，或带 generated inserts 的 source-led edits。

Hybrid 不是万能兜底。你的第一项工作是定义什么保持 primary。

## Runtime Selection（MANDATORY：展示两个 runtimes）

Before locking the production plan, decide `render_runtime` with the user. Hybrid supports BOTH Remotion and HyperFrames; neither is an auto-default. Follow the contract in AGENT_GUIDE.md → "Present Both Composition Runtimes (HARD RULE)":

1. Query `video_compose.get_info()["render_engines"]`. If both `remotion` and `hyperframes` are `True`, present both to the user with brief-specific analysis:
   - **Remotion** — fits when source footage dominates and support layers are React scene components (chart, callout, text card). Remotion composes video clips + React overlays in one pass via `<OffthreadVideo>`.
   - **HyperFrames** — fits when support layers are HTML/GSAP-native (kinetic callouts, registry blocks, typographic overlays) and source footage is embedded as `<video class="clip">`.
2. Recommend one with rationale tied to the anchor medium and the shape of the support layer.
3. Wait for explicit user approval.
4. Log the choice in `decision_log` as a `render_runtime_selection` decision with BOTH runtimes in `options_considered`.

A `render_runtime_selection` decision with only one runtime in `options_considered` when both were available is a CRITICAL reviewer finding.

## Reference Inputs

- `docs/hybrid-video-best-practices.md`
- `skills/creative/storytelling.md`
- `skills/creative/video-editing.md`

## 流程

### 1. 选择 Anchor Medium

选择 storytelling anchor：

- `talking_head`
- `broll_footage`
- `screen_recording`
- `still_sequence`
- `narration_led_graphics`

### 2. 定义 Support Layers

可能的 support layers：

- subtitles,
- diagrams,
- code visuals,
- stat cards,
- generated inserts,
- narration,
- music.

每个 support layer 都应解决具体问题，而不是只装饰 timeline。

### 3. 决定 Deliverable Mix

常见 outputs：

- hero cut,
- vertical cutdown,
- square cutdown,
- chaptered version,
- ad variant.

### 4. 构建 Brief

推荐 metadata keys：

- `anchor_medium`
- `source_inventory`
- `support_layers`
- `deliverable_mix`
- `missing_capabilities`
- `fallback_policy`

### 5. Quality Gate

- the anchor medium is explicit,
- support layers are justified,
- the deliverable mix fits the source inventory,
- missing capabilities are surfaced early.

## Common Pitfalls

- Calling everything hybrid without defining a primary medium.
- Planning support layers before understanding the source.
- Treating optional generated inserts as guaranteed.
