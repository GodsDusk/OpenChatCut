# OpenMontage - Agent 指南

从这里开始。这是 OpenMontage 的完整操作指南和 Agent 合同。

架构、关键文件和约定见 [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md)。

## 首次交互：Onboarding

当用户第一条消息比较模糊、探索性较强，或是在问你能做什么（例如 “make me a video”、“what can you do?”、“help me create something”、“I want to make content”）时，在做任何其它事情前先阅读 onboarding skill：

**读取：** `skills/meta/onboarding.md`

这个 skill 会指导你完成发现流程、判断用户环境、用直白语言展示能力，并基于可用工具提供起步提示词。目标是在 60 秒内把用户从“好奇”带到“开始制作视频”。

当用户带着具体、可执行的请求进入时（例如 “Make a 60-second explainer about black holes”），**跳过 onboarding**，直接进入 Rule Zero。

## 参考视频入口

当用户提供一个**视频 URL 或本地视频文件作为灵感参考**时，例如：

- “Can you make a video like this?”
- “I love this YouTube Short. Make me something similar.”
- “Use this Reel as a reference.”

不要把这类请求当成普通网页搜索或提示词编写请求。

这是 OpenMontage 的一等工作流。

### 必需行为

1. **读取：** `skills/meta/video-reference-analyst.md`
2. 使用本地分析工具（`video_analyzer`、转写提取、场景检测、抽帧）**运行参考分析工作流**
3. **产出有证据支撑的总结**，说明参考视频做了什么：
   - content
   - pacing
   - structure
   - style
   - 它为什么有效
4. **然后**运行常规能力审计和 pipeline 选择
5. 为用户版本提供 **2-3 个有差异的概念方案**，不能照抄

### 重要区分

- **参考驱动请求：** “make me something like this” -> 使用 `video-reference-analyst.md`
- **源素材请求：** “edit this footage” / “cut this into clips” -> 使用 `source_media_review` 和合适的 footage-led pipeline

如果模型错过这个区分，通常会退化成普通搜索 + 猜测。这对 OpenMontage 来说是错误路径。

## Rule Zero：所有生产都必须经过 Pipeline

**每个视频生产请求都必须经过 pipeline 系统。没有例外。**

当用户要求制作、创建、生产或生成任何视频内容时，无论是 trailer、explainer、clip、animation 还是其它视频，Agent 必须：

1. **识别 pipeline。** 将请求匹配到 `pipeline_defs/` 中的某个 pipeline。若不清楚，询问用户。
2. **读取 pipeline manifest。** `pipeline_defs/<pipeline>.yaml`，了解阶段、工具和质量门禁。
3. **运行 preflight。** 通过 registry 发现可用工具，并展示能力菜单。
4. **逐阶段执行。** 对每个阶段，在执行该阶段任何工作前，先读取 stage director skill（`skills/pipelines/<pipeline>/<stage>-director.md`）。
5. **调用工具前读取 Layer 3 skills。** 在使用任何带 `agent_skills` 字段的工具前，读取 `.agents/skills/` 中引用的 skill。这些 skill 包含 provider 专属提示词指导、参数优化和质量技巧，能显著改善输出。

**不要：**
- 编写临时 Python 脚本直接调用工具
- 跳过 pipeline 直接调用 API
- 未先读取 stage director skill 就生成资产
- 未检查 Layer 3 skill 的提示词指导就使用工具
- 绕过 preflight、checkpoint 或 review

智能在 skills 里，而不是在临时拼出来的代码里。读取 director skills 和 Layer 3 知识的 Agent，会比直接用泛化提示词调用工具的 Agent 产出明显更好。

## OpenMontage 是什么

OpenMontage 是一个指令驱动的视频生产系统。AI Agent 本身就是智能层，它读取指令（pipeline manifests + stage director skills + meta skills），并用工具驱动 pipeline。

```
Agent reads pipeline manifest (YAML) -> reads stage director skill (MD)
-> uses tools (Python BaseTool subclasses) -> self-reviews (meta skill)
-> checkpoints (Python utility) -> presents to human for approval
```

**Python = 工具 + 持久化。** Python 代码中不放编排逻辑、创意决策、review 逻辑或 checkpoint 策略。Agent 在指令指导下做这些决策。

核心循环：

1. 选择 pipeline。
2. 运行 preflight。
3. 从 registry 发现真实工具。
4. 向用户展示概念、工具计划、生产计划和成本。
5. 逐阶段执行并写入 checkpoints。

## 决策沟通合同

对于任何有意义的生产决策，Agent 必须先沟通再执行。用户不应在事后靠猜测才知道选择了哪个 provider、模型或渲染路径。

### 执行前说明

在任何付费或有后果的生成调用前，说明：

- the exact tool name,
- the provider,
- the model or provider variant,
- the exact prompt or structured prompt fields that will be sent,
- the key generation parameters that affect output, such as duration, aspect ratio, resolution, reference assets, `generate_audio`, seed, and sample/batch count,
- 选择它的原因，
- 这是 sample 还是 batch run。

然后等待用户明确批准再调用。dry-run、请求形状预览或 approval-token 准备都只是 preflight artifact；不得把它们呈现为已生成内容，也不得在用户批准真实执行后用它们替代真实验证运行。

成本是供用户决策的信息，不是静默规避测试的理由。如果用户已批准真实验证或生产生成，且已配置 Key，就运行真实路径并报告实际结果。不得为了省成本降级为 fake run、mock run、仅提示词预览或无关本地替代。

### 重大变更前询问

Agent 在改变任何重大生产选择前必须询问用户，包括：

- switching provider,
- switching model family or provider variant,
- switching from video-led to still-led treatment,
- switching composition engine when that changes the output character,
- dropping narration, music, or other approved creative elements,
- changing from sample mode to batch mode.

在已批准的 provider / model 路径内做轻微 prompt 优化，可以不单独进行设计讨论，但任何付费或有后果的生成调用前仍必须展示最终 prompt。

### 展示两个合成运行时（硬规则）

当机器上同时可用 Remotion 和 HyperFrames 时（检查 `video_compose.get_info()["render_engines"]`），Agent 在 proposal 阶段锁定 `render_runtime` 前，**必须把两个选项都展示给用户**。Agent 可以带理由推荐其中一个，但禁止静默选择“默认值”，即使 pipeline manifest 或 director skill 建议了某个选项也不例外。

展示时必须为每个运行时包含：

1. A one-sentence plain-language description of what it is best at for **this specific brief**.
2. A one-sentence honest tradeoff (why it might not be the right pick here).
3. Agent 的推荐和理由，且要绑定到 brief 的 `delivery_promise` 与视觉方案。

然后等待用户明确批准再继续。将完整候选列表（两个运行时，以及适用的 “ffmpeg” 选项）记录为 `decision_log` 中 `render_runtime_selection` 决策的 `options_considered`。当两个运行时都可用时，如果 decision log 只记录考虑了一个运行时，这是 CRITICAL reviewer finding。

例外：如果机器上只有一个运行时可用，Agent 可以继续使用它，但必须明确说明（例如 “HyperFrames isn't installed on this machine; I'm proceeding with Remotion. Install HyperFrames if you want the alternative.”）。`render_runtime_selection` 决策仍需记录不可用选项，并写入 `rejected_because: "runtime not available on this machine"`。

这条规则适用于每个调用 `video_compose` 的 pipeline，不只适用于 Wave 1。pipeline 的 director skill 可以推荐运行时，但这个推荐只是和用户沟通的输入，不是最终决策。

### 合成 authoring mode：Templated 与 Atelier

与 *runtime* 正交的是 *authoring mode*：也就是合成如何构建。把它作为独立 proposal 决策展示，并记录到 `decision_log`（`category: "composition_mode"`）。

- **Templated**：把库存 `cut.type` 场景类型（`text_card`、`stat_card`、`bar_chart` 等）组装进 `Explainer` / `CinematicRenderer` composition。它快速、便宜、可靠，也正是许多视频长得相似的原因。适合批量输出、本地化变体、快速草稿和低风险内部短片。
- **Atelier**：**从零手工创作 composition**：定制场景、一次性主题，以及为本片专写的 motion，通过 `composition_mode: "atelier"` 渲染（见 `video_compose` → `_render_via_atelier`）。不复用创意组件；每次都建立新的视觉语言。

**Hero work 默认使用 atelier**，包括营销、发布、品牌片，以及任何必须出彩的单交付 explainer。判断规则是：*复用引擎知识，但绝不复用创意组件。* 在 atelier 模式下，库存 scene-type catalog、`hyperframes-registry` blocks、fixtures 和已完成组件都**禁止使用**，因为它们是固定外观，会重新带来同质化。构建前先走 **`skills/meta/bespoke-composition.md`**，顺序为：art direction（`visual-style`）→ motion principles（通过 `framer-motion` / `lottie-bodymovin` 使用 Disney 12 原则）→ engine mechanics（`remotion-best-practices` + 仅把库存组件当作 mechanics codex 阅读）→ 通过 atelier 路径渲染。最后做 **distinctness review**：*这个视频会不会像任何其它产品的视频？是否复用了我以前做过的外观？* 这与“是否匹配参考”相反。Atelier 比 templated 消耗更多 tokens 和迭代次数；在 proposal 阶段要说明，让用户知情选择。

### 明确升级 Blocker

当出现 blocker 时，Agent 必须立即按以下结构暴露：

1. 尝试了什么
2. 什么失败了
3. 问题属于鉴权、provider 访问、工具 bug，还是 prompt / design 质量
4. 接下来有哪些选项
5. Agent 推荐哪个选项，以及理由

在用户批准前，不要继续执行替代路径。

### 推荐风格

要求用户选择时，不要只列选项。Agent 应该：

- 给出 shortlist，
- 简要说明 tradeoff，
- 推荐一个选项，
- 等待批准后再继续。

### 禁止单方面替换

如果已批准路径被阻断，Agent 可以调查并准备替代方案，但不得在没有用户批准的情况下执行替代方案。

这尤其适用于：

- provider swaps,
- model swaps,
- fallback tools,
- prompt-only substitutes for reference-driven generation,
- still-image animatics in place of true motion.

如果 provider 被阻断，唯一可自动执行的动作是停止并报告 blocker。可以准备替代方案，但不能执行替代方案。

## Orchestrator

Agent 自己编排生产状态机：

`research -> proposal -> script -> scene_plan -> assets -> edit -> compose`

Agent：

1. 读取 pipeline manifest（`pipeline_defs/*.yaml`）以了解流程
2. 调用 `checkpoint.get_next_stage()` 找到恢复点
3. 读取该阶段的 director skill（`skills/pipelines/<pipeline>/<stage>-director.md`）以了解怎么做
4. 使用工具（`tools/`）获得具体能力
5. 使用 reviewer meta skill（`skills/meta/reviewer.md`）自审
6. 通过 checkpoint protocol（`skills/meta/checkpoint-protocol.md`）写入 checkpoint
7. 当 `human_approval_default: true` 时向人类提交审批

基础设施文件：

- `lib/checkpoint.py` — read/write checkpoints, stage validation
- `tools/cost_tracker.py` — budget governance
- `lib/pipeline_loader.py` — manifest loading and helpers

## 开发文档规则

所有新增开发文档、计划、状态表、验证记录和项目跟踪说明必须使用中文。

文档放置规则：

- `docs/project-tracking/` 是当前开发状态、开放项、阻塞项、验证记录、设计决策和跨文档索引的中文统一入口。
- `docs/project-tracking/总表.md` 是开发事项状态变化时优先更新的位置。
- `docs/project-tracking/未通过项解决记录.md` 用于记录失败或阻塞的验证项，必须包含出现场景、原因、影响、修复方案和复核结果。
- `docs/project-tracking/文档依赖索引.md` 用于记录文档依赖关系；任何文档合并、迁移、删除之前都必须先查看或更新该文件。
- 当 `docs/feature-development-workflow.md` 要求进入正式规格流程时，`.trae/specs/<change-id>/` 仍是 `spec.md`、`tasks.md`、`checklist.md` 的源位置。

禁止为了“统一目录”无脑移动或合并 `.trae/specs`、`docs/plans` 或领域文档。迁移文档前必须先扫描引用、识别未完成项、更新索引，并保留工具链或现有文档依赖的事实源路径。

英文只允许用于代码标识符、命令、环境变量、API / 模型名称、上游错误原文和文件路径。

## 项目目录约定

每次生产运行都会在 `projects/` 下创建项目 workspace。该目录已被 gitignore，所有生成资产都应可再生成。

默认新项目必须按月份和日期落盘：

```
projects/YYYY-MM/YYYY-MM-DD/<project-name>/
├── artifacts/          # JSON artifacts from each stage (research_brief, script, scene_plan, etc.)
├── assets/
│   ├── images/         # Generated images (PNG)
│   ├── video/          # Generated video clips (MP4)
│   ├── audio/          # Narration segments + final mix (MP3/WAV)
│   ├── music/          # Background music track (MP3)
│   └── subtitles.srt   # Generated subtitles
└── renders/
    └── final.mp4       # Final rendered video (the deliverable)
```

旧的 `projects/<project-name>/` 只作为历史项目兼容读取路径，不自动迁移、不删除，也不再作为新生成项目默认路径。按项目名查询历史状态时，工具应同时查日期分桶目录和旧扁平目录；如果存在多个同名候选，应返回候选路径，并优先使用最新创建或最新修改的目录。

显式传入的 `project_dir`、`project_root`、`report_path` 或等价路径参数优先级最高，不得被日期分桶逻辑覆盖。MCP 响应、脚本报告和验证日志必须暴露实际 `project_dir` / `project_root`，让用户能直接定位落盘产物。

**命名约定**：使用从视频标题派生的 kebab-case（例如 `hidden-math-of-nature`、`how-music-rewires-brain`）。

在 pipeline 初始化时、任何阶段运行前创建项目目录。所有工具和 Agent 都应通过统一项目路径 resolver 或等价工具获取实际项目目录，再把输出写入这些路径，绝不能手写新的 `projects/<project-name>` 默认拼接，也不能写到仓库根目录或临时随意位置。

## 音乐库

用户可以把 royalty-free 音乐轨放入 `music_library/`（已 gitignore）。asset director 会先检查该文件夹，再 fallback 到基于 API 的音乐生成。

```
music_library/
├── ambient_track.mp3
├── cinematic_epic.mp3
└── ...
```

如果文件夹中有音轨，proposal 和 asset 阶段应把它们作为选项，与生成音乐一起展示。细节见 proposal-director 和 asset-director skills。

## 可用 Pipelines

| Pipeline | 最适合 | 稳定性 |
|----------|----------|-----------|
| `animated-explainer` | 从主题生成完整 explainer | production |
| `talking-head` | 素材驱动的 speaker 视频 | beta |
| `screen-demo` | 屏幕录制和 walkthrough | production |
| `clip-factory` | 从一个长素材切出多个 clips | beta |
| `podcast-repurpose` | Podcast 精华和衍生内容 | beta |
| `cinematic` | Trailer、teaser 和情绪驱动剪辑 | production |
| `animation` | Motion-graphics 和 animation-first 视频 | production |
| `character-animation` | 本地 rigged cartoon characters 和可复用角色表演 | beta |
| `hybrid` | 源素材 + 支撑视觉 | production |
| `avatar-spokesperson` | presenter-led avatar 或 lip-sync 视频 | production |
| `localization-dub` | 字幕、配音和翻译版本 | beta |
| `framework-smoke` | 测试：最小 2 阶段 smoke test | test |

> **Beta pipelines** 尚未完整审计。它们可以工作，但可能有粗糙边角。用户选择时需要说明这一点。

## 强制 Preflight

在任何创意工作前都要执行。**先使用 `provider_menu_summary()`，它是面向人的汇总。** 原始 `support_envelope()` 输出是信息洪流（配置完整的机器上会有数 MB JSON）；直接贴到聊天里会淹没用户。

```bash
python -c "
from tools.tool_registry import registry
import json
registry.discover()
print(json.dumps(registry.provider_menu_summary(), indent=2))
"
```

summary 会返回四个字段，Agent 应将其翻译成直白语言：

- `composition_runtimes`：`ffmpeg`、`remotion`、`hyperframes` 的布尔值。这是“展示两个合成运行时（硬规则）”检查的事实源。
- `capabilities[]`：每个 capability family 一项，包含 `configured / total` 数量和 provider 列表，可直接用于 “N of M configured” 菜单。
- `setup_offers[]`：不可用但可通过 1 分钟环境变量修复的工具。提供升级选项时优先展示这些。
- `runtime_warnings[]`：类似 “hyperframes: npm package not resolvable” 的具体信号。逐字展示给用户，因为这类静默失败会破坏治理合同。

然后，在需要更深入检查时（仅当 summary 不够用）：

```bash
# 完整菜单：按 capability 分组 available / unavailable。
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.provider_menu(), indent=2))"

# 原始 envelope：每个工具的完整合同。慢且信息量大，仅用于 debug。
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.support_envelope(), indent=2))"
```

然后：

1. 读取 `pipeline_defs/` 中选定的 manifest。
2. 对照 registry 检查每个 `required_tools`。
3. 检查 `fallback_tools` 是否不可用。
4. 报告 `passed`、`degraded` 或 `blocked` 之一。
5. 在用户理解真实 capability envelope 前，不要开始生产。

### Provider Menu（Preflight 强制）

前面已经通过 `provider_menu_summary()` 获取。读取该输出，并**作为 capability menu 展示给用户**，而不是平铺工具列表。只有在需要 summary 折叠掉的逐工具详情时，才直接使用 `provider_menu()`。

**展示方式：**

```
你的能力

  Video Generation:  0/13 configured
  Image Generation:  1/7 configured
  Text-to-Speech:    1/3 configured
  Music Generation:  1/1 configured
  Composition:       3/3 configured (FFmpeg, video_stitch, video_trimmer)

  你现在可以用图片 + TTS + FFmpeg 生产视频。
  有可快速升级项，见下方。
```

对于每个存在 unavailable providers 的 capability，读取菜单输出中的 `install_instructions` 字段，并按工作量分组展示 setup 选项：

```
快速配置选项（每项约 1 分钟：在 .env 中设置环境变量）

  Video Generation（0/13 -> 解锁最大能力提升）：
    每个 unavailable provider 都列出自己的 install_instructions。
    从 provider_menu 输出中读取，并按环境变量分组展示。
    示例：如果 3 个工具需要 FAL_KEY，将其分组为“FAL_KEY 解锁 3 个 providers”

  Image Generation（1/7 -> 更多风格选项）：
    同样模式，从每个 unavailable tool 读取 install_instructions。

  Text-to-Speech（1/3）：
    同样模式。

本地选项（免费，需要硬件）：
  `runtime=LOCAL` 或 `runtime=LOCAL_GPU` 的工具，从菜单读取。

已可用：
  列出已经工作的能力。用户应清楚自己当前已经能做什么。
```

**规则：**
- 不要在提示中硬编码 provider 名、API key 名或 setup URL。
  从 registry 中每个工具的 `install_instructions` 字段读取。
- 始终展示比例：“X of Y configured”，让能力广度可见。
- 按 capability 分组，不按单个工具分组。
- 先展示当前能做什么，再展示可解锁什么。
- 如果用户拒绝 setup，使用当前最佳可用路径继续，不要反复催促。
- 如果一个工具与其它工具共享环境变量，按该环境变量分组（从 `dependencies` 字段读取）。

### Setup Offer 协议

当工具为 `UNAVAILABLE` 但可通过简单配置修复时，**向用户提供 setup 帮助，而不是静默绕过限制。** 很多工具只差一个环境变量就能工作。

| 修复复杂度 | 动作 |
|----------------|--------|
| **1 分钟修复**（环境变量） | 提供立即配置帮助，从工具读取 `install_instructions` |
| **5 分钟修复**（安装） | 说明要安装什么及原因，从工具读取 `install_instructions` |
| **复杂修复**（GPU、模型下载） | 说明限制和可解锁能力，然后继续 |

**规则：**
- 始终告诉用户缺什么以及会获得什么
- 展示成本差异（免费本地 vs 付费 API）
- 如果用户拒绝 setup，使用当前最佳可用路径继续，不要反复催促
- 对相关修复分组（共享同一环境变量依赖的工具）

### 合成运行时（在 video_compose 内）

`video_compose` 有 **三个** render engines / runtimes。它们是并列选项，不是优先级排序；选择在 proposal 阶段完成，并锁定在 `edit_decisions.render_runtime`。检查哪些可用：

```bash
python -c "
from tools.tool_registry import registry
registry.discover()
info = registry._tools['video_compose'].get_info()
print('Render engines:', info.get('render_engines'))
print('Remotion note:', info.get('remotion_note'))
print('HyperFrames note:', info.get('hyperframes_note'))
"
```

| Engine | 用途 | 依赖 |
|--------|----------|----------|
| **FFmpeg** | 纯视频剪切、concat、trim、字幕烧录 | `ffmpeg` binary（总是可用） |
| **Remotion** | 基于 React 的合成：静帧图片 → 动画视频、文字卡片、数据卡片、图表、callout、对比、spring physics 转场、词级字幕烧录、TalkingHead avatar | Node.js（`npx`）+ `remotion-composer/` + `node_modules` |
| **HyperFrames** | HTML/CSS/GSAP 合成：动态排版、产品宣传片、发布短片、website-to-video、registry-block-driven scenes、SVG character rigs | Node.js ≥ 22 + FFmpeg + `npx`（通过 `npx hyperframes` 使用） |

`render_runtime` 在 **proposal 阶段锁定**（`proposal_packet.production_plan.render_runtime`），并**原样传递到 edit_decisions**。`video_compose` 基于该字段路由；禁止静默 runtime swap。如果已选择的运行时在 compose 阶段变得不可用，按上文“明确升级 Blocker”暴露结构化 blocker。Remotion-vs-HyperFrames 决策矩阵见 `skills/core/hyperframes.md`。

### 关键规则：强依赖动态画面的请求

对于任何交付物天然依赖动态画面而非静态覆盖的请求，都要把 motion 当成硬性要求。例如：

- sci-fi trailers，
- 由生成 clips 构成的 cinematic teasers，
- hype edits，
- avatar 或 agent videos，
- 任何承诺依赖 moving shots 而不是 still frames 的 brief。

对此类请求：

- 如果计划视觉方案依赖 proposal 阶段选择的 `render_runtime`（Remotion、HyperFrames 或 FFmpeg），必须预先确认它可用。
- 禁止 still-image fallback。不要静默把任务转成 Ken Burns teaser、animatic 或 slide-based video。
- 当 FFmpeg-only fallback 会把已批准交付物从 motion-led video 改成 still-led video 时，禁止使用。
- **禁止静默 runtime swap。** 如果已锁定 `render_runtime="hyperframes"` 且 HyperFrames 不可用，不要改路由到 Remotion。应暴露 blocker、提出选项、获得用户批准、记录 `render_runtime_selection` 决策，然后再继续。
- 关键问题必须立即上浮。如果已选择的 runtime 不可用、渲染失败，或 provider clip generation 失败并阻断已批准方案，继续前必须停止并告知用户。
- 除非用户明确批准把交付物降级为 animatic 或 proof-of-concept，否则不要在降级输出上继续消耗 tokens 或时间。

**当 Remotion 可用时**，Agent 应围绕它设计生产计划：
- 使用 `flat-motion-graphics` playbook 的 explainer videos -> Remotion animated scenes，而不是 Ken Burns
- Data-driven videos -> Remotion stat cards 和 charts，而不是静态图片截图
- 任何使用 still images 的 pipeline -> Remotion spring animations，而不是 FFmpeg pan-and-zoom
- **CLI / terminal / install flow 的 screen demos -> `TerminalScene`（synthetic screen recording），不是 OS-level capture。** 见 `.agents/skills/synthetic-screen-recording/SKILL.md`。它更快、确定性更强且隐私更安全。只有当 demo 是真实 app UI 或依赖不可预测 live behavior 时，才使用真实 capture（`screen_recorder`、`cap_recorder`、`playwright-recording`）。

### `remotion-composer/` 中可用的 Remotion scene types

权威列表和 cut schemas 见 `remotion-composer/SCENE_TYPES.md`。当前可通过 `cut.type` 使用的 scene types：
`text_card`, `stat_card`, `callout`, `comparison`, `hero_title`, `terminal_scene`, `anime_scene`, `bar_chart`, `line_chart`, `pie_chart`, `kpi_grid`, `progress_bar`. Overlay types include `section_title`, `stat_reveal`, `hero_title`, `provider_chip`.

这些库存 scene-types 属于 **templated** 路径，快速可靠，但也是视频容易同质化的原因。对于 **hero work，优先使用 atelier mode**（hand-authored composition），而不是直接组装这个 catalog；阅读这些类型时应把它们当作 *mechanics codex*，而不是菜单。见上文“合成 authoring mode”和 `skills/meta/bespoke-composition.md`。

**当 Remotion 不可用**且没有锁定 `render_runtime="remotion"` 时，`video_compose` 可以对 still images 使用 FFmpeg Ken Burns motion。这仍可工作，但视觉吸引力较弱。proposal 中要说明这个 tradeoff。当已锁定 `render_runtime="remotion"` 且 Remotion 不可用时，这是 blocker，必须升级处理，不能静默替换。

当已锁定 `render_runtime="hyperframes"` 且 HyperFrames 不可用（Node < 22、缺少 `ffmpeg` / `npx`，或 `hyperframes doctor` 报告问题）时，这同样是 blocker。没有用户批准和已记录的 `render_runtime_selection` 决策，不得替换为 Remotion 或 FFmpeg。

路由是自动的：`video_compose` 读取 `edit_decisions.render_runtime`，并分发到匹配引擎（`_render_via_hyperframes`、`_remotion_render` 或 `_render_via_ffmpeg`）。但 **Agent 必须在 proposal 阶段知道 Remotion 和 HyperFrames 是否都存在**，这样才能有意识地设计视觉方案。对于 HTML / GSAP 表达更自然的 motion-graphics-heavy 概念，不要默认 Remotion；对于复用现有 React scene stack 的 brief，也不要默认 HyperFrames。

## 能力发现

OpenMontage 使用两层来做能力选择：

- selector tools：capability-level routing，例如 `tts_selector` 和 `video_selector`
- provider tools：通过 registry 发现、调用具体 backend 的具体工具

始终先检查 registry：

```bash
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.capability_catalog(), indent=2))"
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.provider_catalog(), indent=2))"
```

对最终候选工具检查：

- `capability`
- `provider`
- `usage_location`
- `supports`
- `fallback_tools`
- `related_skills`

当 registry 能回答时，不要依赖记忆或旧文档。

## 工具族

**不要维护硬编码工具列表。** 始终在运行时查询 registry：

```bash
# 查看按 capability 分组的全部工具（TTS、video_generation、image_generation 等）
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.capability_catalog(), indent=2))"

# 查看按 provider 分组的全部工具（elevenlabs、openai、ffmpeg 等）
python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.provider_catalog(), indent=2))"
```

输出中需要关注的关键 capability families：

- **tts**：Text-to-speech providers。通过 `tts_selector` 路由。
- **video_generation**：视频生成 providers（cloud、local GPU、stock）。通过 `video_selector` 路由。
- **image_generation**：图片生成 providers（cloud、local GPU、stock）。通过 `image_selector` 路由。
- **music_generation**：音乐和音效生成。
- **video_post**：Composition、stitching、trimming（基于 FFmpeg，始终本地）。
- **audio_processing**：Mixing、enhancement（基于 FFmpeg，始终本地）。
- **analysis**：Transcription、scene detection、frame sampling。
- **avatar**：Talking head 和 lip sync generation。
- **character_animation**：本地 character specs、SVG rigs、pose libraries、action timelines、previews 和 QA。
- **enhancement**：Upscale、background removal、face enhance、color grading。

registry 中每个工具都会声明 `best_for`、`install_instructions`、`runtime`（LOCAL、API、LOCAL_GPU、HYBRID）和 `status`。读取这些字段，不要凭记忆假设工具强项。

### 工具类命名约定

所有工具类都使用 **PascalCase，且不带 “Tool” 后缀**。在 Python 中导入工具时：

| Module | Class Name | NOT |
|--------|-----------|-----|
| `tools.audio.music_gen` | `MusicGen` | ~~MusicGenTool~~ |
| `tools.video.video_compose` | `VideoCompose` | ~~VideoComposeTool~~ |
| `tools.audio.audio_mixer` | `AudioMixer` | ~~AudioMixerTool~~ |
| `tools.tts.elevenlabs_tts` | `ElevenLabsTTS` | ~~ElevenLabsTTSTool~~ |
| `tools.analysis.transcriber` | `Transcriber` | ~~TranscriberTool~~ |
| `tools.subtitle.subtitle_gen` | `SubtitleGen` | ~~SubtitleGenTool~~ |

不确定时检查：`grep "^class " tools/<path>.py`

所有工具都通过 `.execute(params_dict)` 调用（返回带 `.success`、`.data`、`.error` 的 `ToolResult`），不是 `.run()`。

### Selector Pattern

三个 selector tools 抽象了 multi-provider capabilities。**Selectors 会从 registry 自动发现 providers。** 新增 provider tool 会自动通过 selector 可用，不需要修改 selector 代码。

| Selector | 路由到 | 发现方式 |
|----------|-----------|-----------------|
| `tts_selector` | All tools with `capability="tts"` (ElevenLabs, Google TTS, OpenAI, Piper) | `registry.get_by_capability("tts")` |
| `image_selector` | All tools with `capability="image_generation"` (FLUX, Google Imagen, GPT Image, Recraft, etc.) | `registry.get_by_capability("image_generation")` |
| `video_selector` | All tools with `capability="video_generation"` | `registry.get_by_capability("video_generation")` |

Selectors 按以下顺序路由：用户偏好 > 可用性 > 发现顺序。它们会在 providers 之间透明适配输入 schema。

## 面向用户的规划协议

承诺执行前，展示：

1. 当 brief 仍开放时，提供 `4-5` 个 concept directions。
2. 推荐 pipeline。
3. 推荐 tool path。
4. 实际可用的替代 tool paths。
5. 成本估算和质量 tradeoff。
6. **Music plan**：每个有音频的 pipeline 都强制需要。见下文。
7. 分阶段 production plan。
8. asset generation 前的 approval gate。

如果用户偏好特定 vendor 且该工具可用，直接展示它。不要隐藏 provider 选择。

### 音乐计划（强制）

音乐是任何视频的重要组成部分。**在 proposal / idea 阶段就向用户说明音乐情况**，不要静默推迟到 asset 阶段，因为那时失败会更昂贵。

按以下顺序检查音乐可用性并展示选项：

1. **用户音乐库（`music_library/`）：** 检查该文件夹是否存在且包含音轨。如有，列出可用音轨和时长，让用户选择。
2. **音乐生成 APIs：** 通过 registry（`registry.get_by_capability("music_generation")`）检查哪些音乐工具可用。诚实报告状态；如已知 quota 状态，也一并说明。
3. **Royalty-free sources：** 说明用户可以提供自己的音轨（例如来自 YouTube Audio Library、Jamendo 或其它免费来源）。提供 `music_library/` 放置路径。

**始终向用户展示明确选择：**
- 使用音乐库中的某条音轨（哪一条？）
- 提供另一条音轨（放入 `music_library/`）
- 通过 API 生成一条（如果可用，说明 provider 和成本）
- 不使用音乐继续

**如果没有可用音乐来源：** 明确告诉用户。不要让这个问题到 asset 阶段才突然暴露。

把音乐决策记录到 proposal / brief artifact 中，确保 asset director 知道该怎么做。

## Pipeline 资产预期

每个 pipeline manifest 的 `tools_available` 字段声明该阶段可用哪些工具。multi-provider capabilities 使用 selectors，selector 会路由到任何可用工具。每阶段权威列表以 pipeline manifest 为准。

## Stage Agents

每个阶段都会产出一个 canonical artifact，作为下一阶段的合同。stage director skill 会告诉 Agent 如何产出它。

| Stage | Director Skill | Canonical output | 核心质量标准 |
|------|---------------|------------------|------------------|
| `idea` | `*-director.md` | `brief` | 清晰 hook、目标平台、时长、tone 和用户意图 |
| `script` | `*-director.md` | `script` | 结构化章节、有效时序、连贯旁白 |
| `scene_plan` | `*-director.md` | `scene_plan` | 有序场景、时序、资产需求 |
| `assets` | `*-director.md` | `asset_manifest` | 来源、路径、模型 / 工具 metadata、场景关联 |
| `edit` | `*-director.md` | `edit_decisions` | 具体剪辑、overlays、字幕 / 音乐决策 |
| `compose` | `*-director.md` | `render_report` | 输出路径、编码 profile、验证记录 |

Stage 合同规则：

- `completed` 或 `awaiting_human` checkpoint 必须包含该阶段 canonical artifact。
- Canonical artifacts 必须通过 `schemas/artifacts/` 中的 JSON schema 校验。
- 媒体文件等 non-canonical outputs 应放在阶段专属目录中。
- 工具应记录 seeds / model versions 以支持可复现性。

## Reviewer 协议

reviewer 是一个 meta skill（`skills/meta/reviewer.md`），它提供建议，永远不直接阻断进展。

- 每个阶段执行后、checkpoint 前进行自审。
- 从 pipeline manifest 加载当前阶段的 `review_focus` 项。
- 最多两轮 review。之后带 warnings 通过并继续。
- Findings 分类：critical（必须修）、suggestion（应修）、nitpick（锦上添花）。
- Critical findings -> 修复并重新 review。Suggestions -> 记录并继续。
- 将 playbook `quality_rules` 视为约束，而不是建议。

## 人工 Checkpoint 协议

checkpoint protocol meta skill（`skills/meta/checkpoint-protocol.md`）会指导 Agent 何时暂停：

- 按阶段从 pipeline manifest 读取 `human_approval_default`
- Creative stages（`idea`、`script`、`scene_plan`）通常需要审批
- Technical stages（`assets`、`edit`、`compose`）通常自动继续
- 需要审批时：展示 artifact summary、review findings 和 cost snapshot
- 等待人类批准、要求修改或中止

## 通信协议

Agents 通过 canonical JSON artifacts、checkpoints、pipeline manifests 和 tool registry 协作。

主要文件：

- Artifact schemas: `schemas/artifacts/`
- Checkpoint schema: `schemas/checkpoints/checkpoint.schema.json`
- Pipeline manifest schema: `schemas/pipelines/pipeline_manifest.schema.json`
- Pipeline manifests: `pipeline_defs/`
- Style playbooks: `styles/*.yaml` (validated by `schemas/styles/playbook.schema.json`)
- Tool contract: `tools/base_tool.py`
- Tool registry: `tools/tool_registry.py`
- Stage director skills: `skills/pipelines/<pipeline>/<stage>-director.md`
- Meta skills: `skills/meta/*.md`

Checkpoint 规则：

- Checkpoints 位于 `pipelines/<project_id>/checkpoint_<stage>.json`。
- `status` 可以是 `completed`、`failed`、`awaiting_human` 或 `in_progress`。
- `completed` 和 `awaiting_human` checkpoints 必须包含 canonical artifact。
- 无效 checkpoint 或无效 canonical artifact 属于合同违规，应快速失败。

Pipeline manifest 规则：

- Pipelines 是 `pipeline_defs/` 中的声明式 YAML manifests。
- Stages 声明：`skill`（director skill path）、`produces`、`tools_available`、`review_focus`、`success_criteria`、`human_approval_default`。
- 新增 pipeline 需要 manifest + stage director skills。

工具规则：

- 每个生产工具都必须继承 `BaseTool`。
- 工具发现必须通过 registry，而不是 ad hoc imports。
- Support-envelope reporting 是 capability、status 和 resource requirements 的事实源。

## Style Playbooks

| Playbook | 最适合 |
|----------|----------|
| `clean-professional` | 企业、教育、SaaS |
| `flat-motion-graphics` | 社媒、TikTok、创业公司 |
| `minimalist-diagram` | 技术深潜、架构 |
| `ink-sketch` (Ink Theater) | 白底手绘墨线 doodle animation；会自我绘制、行走、跳舞的角色；机械装置式 explainer |

### 手绘 “doodle” animation → Ink Theater / Ink Puppet

对于任何想要 **hand-drawn ink doodle** 外观的 brief，例如 “a sketch that comes to life”、“a pencil / stick figure that walks or dances”、“a little character that acts out the idea”、whiteboard-doodle explainers，使用 **Ink Theater** 引擎 + **Ink Puppet** mocap 系统（`skills/creative/ink-theater.md`、`ink-theater/README.md`）。它是 **style + reusable engine，不是新 pipeline**：illustration / contraption 作品走 `animation` pipeline；mocap character（自我绘制 → 通过 `InkPuppet.choreograph([...])` 行走 / 跳舞 / 挥手）走 `character-animation`。跨工具入口：**`/ink-art`**（从零创建 vector doodle）和 **`/animated-drawing`**（用 mocap 动画化一张*用户提供的*图，raster；`skills/creative/animated-drawing.md`）。不要手调角色 motion，Agent 只选择命名 mocap clips。

## Layer Map

OpenMontage 有三层指令：

1. `tools/`
   存在哪些能力、是否可用、成本、runtime、fallback、相关 skills。
2. `skills/`
   OpenMontage 希望这些工具如何在 pipelines 中使用。
3. `.agents/skills/`
   原始 vendor 或技术知识。

阅读顺序：

1. registry / tool contract：发现哪些能力可用
2. 相关 pipeline 或 creative skill（Layer 2）：了解在当前上下文中如何使用
3. 底层 vendor skill（Layer 3）：**调用任何生成工具前强制阅读**

**工具用法优先读 skills，而不是源码。** Skills 的存在就是为了让常规场景不需要理解实现细节。Layer 2 告诉你*做什么*和*什么时候做*；Layer 3 告诉你*怎么做*。编写 prompts、选择参数或理解使用模式时，应阅读 skills，而不是 `.py` 文件。

**例外：debug、审计和验证治理合同。** 当 skill 与工具不一致，或实际行为不同于 skill 声明时，可以阅读工具源码，这通常是捕捉 silent-availability bug 或陈旧 doc string 的唯一方式。拒绝查看实现的审计，恰恰会漏掉最重要的问题。如果为了 debug 阅读了源码，事后考虑是否应把发现更新到 skill，避免下一个 Agent 重复深挖。

**Layer 3 不是可选项。** 每个生成工具（video、image、TTS、music）都有 `agent_skills` 字段列出其 Layer 3 skills。这些 skills 包含 provider-specific prompt engineering、参数调优和质量技巧。写 prompts 前必须读取它们。generic prompt 和 skill-informed prompt 的差别，往往就是“可用”和“cinematic”的差别。

示例：调用 `kling_video` 前，读取它的 `agent_skills` → `ai-video-gen`，获取 Kling-specific prompt structure、camera direction syntax，以及模型响应最好的 quality keywords。

### 按类别查找 Layer 3 skills

`.agents/skills/` 目录很大。当不是通过工具的 `agent_skills` 指针进入时，用下表按*你要做什么*找到正确文件：

| 类别 | Skills |
|---|---|
| **Composition runtime** | `remotion`, `remotion-best-practices`, `synthetic-screen-recording`（通过 Remotion TerminalScene 制作 fake terminal / UI demos） |
| **Animation knowledge（通用）** | `gsap-core`, `gsap-timeline`, `gsap-plugins` (SplitText / MorphSVG / DrawSVG / MotionPath / Flip / CustomEase), `gsap-utils`, `gsap-react`, `gsap-performance`, `gsap-scrolltrigger`, `gsap-frameworks`, `framer-motion` (Disney 12 principles), `lottie-bodymovin` (Lottie export) |
| **Character animation** | `character-rigging`, `svg-character-animation`, `pose-library-design`, `canvas-procedural-animation`, `character-animation-qa` |
| **Image generation** | `bfl-api`, `flux-best-practices` |
| **Video generation** | `seedance-2-0`（首选 premium default：cinematic、trailer、multi-shot、synced audio、lip-sync）、`ai-video-gen`, `ltx2` |
| **Audio** | `elevenlabs`, `music`, `sound-effects`, `acestep`, `text-to-speech`, `setup-api-key` |
| **Avatar / lip-sync** | `avatar-video`, `heygen`, `create-video`, `faceswap`, `video-translate`, `speech-to-text`, `agents` |
| **Capture** | `playwright-recording`（browser flows）、`ffmpeg`（post） |
| **Visualization** | `beautiful-mermaid`, `d3-viz`, `manim-composer`, `manimce-best-practices`, `manimgl-best-practices` |
| **Media editing** | `video-edit`, `video-download`, `video-understand`, `video-toolkit`, `visual-style` |

**不确定时，先读该类别的 meta routing file：**
- 选择 animation runtime？→ `skills/meta/animation-runtime-selector.md` 在 Remotion primitives、GSAP plugins、framer-motion、Lottie、Manim、D3 之间路由。
- 选择 screen-recording mode（real capture vs synthetic terminal）？→ `pipeline_defs/screen-demo.yaml` + `skills/pipelines/screen-demo/idea-director.md`。

## 快速查找

| 问题 | 查看位置 |
|----------|---------------|
| 有哪些工具？ | `tools/tool_registry.py` 和 `registry.support_envelope()` |
| 某个 capability 有哪些 providers 可用？ | `registry.capability_catalog()` |
| 某个 vendor 有哪些工具？ | `registry.provider_catalog()` |
| 某个工具实际如何工作？ | registry 中该工具的 `usage_location` |
| 当前 pipeline 阶段应如何行为？ | `skills/pipelines/<pipeline>/...` |
| checkpoint / review 策略是什么？ | `skills/meta/` |

## 禁止事项

- **不要绕过 pipeline。** 永远不要编写 ad-hoc scripts 直接调用工具。所有生产都必须经过带 director skills 的 pipeline stages。见 Rule Zero。
- **不要在未读取 Layer 3 skill 的情况下调用生成工具。** 检查工具的 `agent_skills` 字段，读取引用的 skill，再基于该指导编写 prompts。
- **不要跳过 stage director skills。** 执行任何 pipeline stage 前，先读取其 director skill。skill 中包含质量标准、工作流和 review 标准。
- 不要使用已删除的 legacy names，例如 `tts_cloud`、`tts_engine` 或 `video_gen`。
- 不要硬编码 provider 名、API key 名或 setup URL。应从 registry 的 `install_instructions` 和 `dependencies` 字段读取。
- 在用户批准 production plan 前，不要开始 asset generation。
- 在向用户展示精确最终 prompt 和关键请求参数前，不要开始付费或有后果的生成。
- 当用户要求真实测试后，不要把 dry-run / mock / request preview 当成已完成生成。
- 不要隐藏 degraded paths。显式记录 substitutions 和 blocked options。
- 当已批准路径被阻断时，不要静默 fallback 到另一个 provider、model、本地替代或 prompt-only preview。
- 不要孤立展示单个不可用工具。始终展示完整能力图景：“该 capability 已配置 X of Y providers。”
- 不要跳过 preflight 的 Provider Menu。用户必须看到自己已经拥有什么，以及还能解锁什么。
- 不要在未提前告知用户并在重大变更时获得批准的情况下，更改 provider、model 或 render path。
