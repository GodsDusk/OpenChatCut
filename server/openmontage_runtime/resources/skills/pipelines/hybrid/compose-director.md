# Compose Director - Hybrid Pipeline

## 何时使用

渲染 hybrid project，确保 source media、support graphics 和 audio 在所有 outputs 中保持 coherent。

## Runtime Routing（MANDATORY first step）

Read `edit_decisions.render_runtime`. Hybrid work typically sticks with Remotion because source footage + React support overlays compose cleanly in one pass:

- **`render_runtime="remotion"`** — default. Source footage via `<OffthreadVideo>`, support graphics as React components, one render.
- **`render_runtime="hyperframes"`** — pick only when the support layer is HTML/GSAP-native (e.g., animated text callouts, registry blocks). Source footage is still possible via `<video class="clip">` but lose some of the Remotion component stack. See `skills/core/hyperframes.md`.
- **`render_runtime="ffmpeg"`** — rare on this pipeline; implies no generated support layer.

Silent runtime swap is a CRITICAL governance violation. Escalate blockers per AGENT_GUIDE.md before substituting.

**Pass `proposal_packet` to `video_compose.execute()`** so the tool's in-tool swap-detection check runs against the proposal directly instead of being `skipped`.

## Prerequisites

| Layer | Resource | Purpose |
|-------|----------|---------|
| Schema | `schemas/artifacts/render_report.schema.json` | Artifact validation |
| Prior artifacts | `state.artifacts["edit"]["edit_decisions"]`, `state.artifacts["assets"]["asset_manifest"]` | Edit logic and support assets |
| Tools | `video_compose`, `audio_mixer`, `video_stitch`, `video_trimmer`, `color_grade`, `audio_enhance` | Final assembly and polish |
| Playbook | Active style playbook | Output consistency |

## 流程

### 1. 验证 Source 与 Support 的平衡

final render 仍应看起来像带 support 的 source-led video，而不是无关系统拼成的 collage。

### 2. 检查 Variant Integrity

对每个 output variant，验证：

- crop safety,
- text safety,
- subtitle legibility,
- audio consistency.

### 3. 保持 Audio Coherent

Source dialogue、narration、music 和 effects 应听起来像一个整体 mix，而不是争夺空间的分离 layers。

### 4. 使用 Render Metadata

推荐 metadata keys：

- `variant_outputs`
- `balance_checks`
- `subtitle_checks`
- `audio_notes`

## Common Pitfalls

- Good master cut, broken platform variants.
- Support graphics clipping in vertical exports.
- Audio loudness shifting between source and generated sections.
