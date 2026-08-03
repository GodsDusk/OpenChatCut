# Asset Director - Hybrid Pipeline

## 何时使用

这个 stage 围绕 anchor edit 准备 support kit：subtitles、diagrams、generated inserts、narration、music 和 reusable overlay systems。

## Prerequisites

| Layer | Resource | Purpose |
|-------|----------|---------|
| Schema | `schemas/artifacts/asset_manifest.schema.json` | Artifact validation |
| Prior artifacts | `state.artifacts["scene_plan"]["scene_plan"]`, `state.artifacts["script"]["script"]`, `state.artifacts["idea"]["brief"]` | Support needs and variant plan |
| Tools | `subtitle_gen`, `tts_selector`, `image_selector`, `video_selector`, `diagram_gen`, `code_snippet`, `music_gen`, `audio_enhance` — selectors auto-discover all available providers from the registry | Optional support asset production |
| Playbook | Active style playbook | Consistency rules |

## 流程

### 1. 先构建 Shared Support Assets

从 reusable systems 开始：

- subtitle treatment,
- lower-third or label system,
- stat-card system,
- CTA container,
- diagram style.

### 1b. Sample Preview（防止浪费成本）

batch-generating support assets 前，为每种昂贵 generated type 产出一个 sample，并展示给用户：

1. **TTS sample** (if narration is needed): Generate one section. Confirm voice and tone before batching.
2. **Image/video sample** (if generating inserts): Generate one representative visual. Confirm style fits the source footage before batching.

如果被拒绝，调整参数并重试（最多 3 次迭代）。获批前不要 batch。

### 2. 只生成需要的 Support Assets

Support assets 应填补 script 和 scene plan 中已识别的 needs，而不是 speculative possibilities。

### 3. 保留 Anchor Truth

在 metadata 中清楚说明哪些 assets 是：

- source-derived,
- provided,
- recorded,
- generated.

### 4. 使用 Metadata 表达 Support Map

推荐 metadata keys：

- `shared_support_assets`
- `scene_asset_index`
- `source_vs_generated_map`
- `variant_assets`

### 5. Quality Gate

- support assets map to real narrative needs,
- reusable kits are present,
- source and generated assets are clearly separated,
- every referenced file exists.

### Mid-Production Fact Verification

If you encounter uncertainty during asset generation:
- Use `web_search` to verify visual accuracy of subjects (e.g. what does this building actually look like?)
- Use `web_search` to find reference images before generating illustrations
- Log verification in the decision log: `category="visual_accuracy_check"`

Visual accuracy 很重要。如果 script 提到具体地点、人物或物体，在生成 images 前核实它实际长什么样。不要依赖 AI model 的 training data；它可能错误或过时。

## Common Pitfalls

- Overbuilding support assets before the anchor cut is proven.
- Losing track of which assets are generated versus supplied.
- Creating inconsistent overlay systems across one project.


## 当你不知道怎么做时

If you encounter a generation technique, provider behavior, or prompting pattern you are unsure about:

1. **Search the web** for current best practices — models and APIs change frequently, and the agent's training data may be stale
2. **Check `.agents/skills/`** for existing Layer 3 knowledge (provider-specific prompting guides, API patterns)
3. **If neither helps**, write a project-scoped skill at `projects/<project-name>/skills/<name>.md` documenting what you learned
4. **Reference source URLs** in the skill so the knowledge is traceable
5. **Log it** in the decision log: `category: "capability_extension"`, `subject: "learned technique: <name>"`

This is especially important for:
- **Video generation prompting** — models respond to specific vocabularies that change with each version
- **Image model parameters** — optimal settings for FLUX, GPT Image, Imagen differ and evolve
- **Audio provider quirks** — voice cloning, music generation, and TTS each have model-specific best practices
- **Remotion component patterns** — new composition techniques emerge as the framework evolves

不要依赖 stale knowledge。有疑问时先搜索。
