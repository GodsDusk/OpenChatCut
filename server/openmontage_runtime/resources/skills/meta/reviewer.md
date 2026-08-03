# Reviewer — Meta Skill

## 何时使用

在完成任一 pipeline stage 的工作后、写入 checkpoint 前使用。你是 “work done” 与 “work accepted” 之间的质量门禁。本 skill 用指令驱动的 self-review protocol 取代 Python reviewer class。

每个 stage 都必须 review。没有例外。review 质量决定最终视频是否值得观看。

## Critique Quality（CHAI Rules）

> Findings ≠ critiques。finding 识别问题；critique 告诉下一阶段如何修复。CMU / Harvard CHAI 研究（“Building a Precise Video Language with Human-AI Oversight”，arXiv 2604.21718v2）表明，按三个维度衡量的 critique quality 会直接支配下游输出质量。每次 reviewer pass 都必须应用这三项。
>
> **Accurate。** 每条 finding 都必须引用具体 artifact field、行号或可见 asset frame。禁止幻觉式批评；如果你无法指出问题在哪里，那就是在猜。
>
> **Complete。** 一个 reviewer pass 抓住一个错误却漏掉第二个错误，比标记 “needs another pass” 并继续更糟。如果你发现一个 critical issue，在返回前扫描同类问题的其它位置。做 pattern-match：这个 artifact 中还有哪里可能藏着同类错误？
>
> **Constructive。** 每个 “critical” finding 都必须提出具体修复，不只是指出问题。“Caption is wrong” → “Caption says 'man on the right'; the man is on the left of the frame. Replace with 'the man on the left of the frame.'” 如果你无法提出修复，把 finding 标为 “investigation”，不要标为 “critical”。
>
> 移除三项中的任何一项都会可测量地损害 pipeline output。reviewer 是关键 choke point，必须严格。

## 协议

### Step 1：加载 Review Context

review 前先收集：
1. 当前 stage 在 pipeline manifest 中的 **Review focus items**（`review_focus` 字段）
2. 当前 stage 在 manifest 中的 **Success criteria**（`success_criteria` 字段）
3. **Active playbook** quality rules
4. 当前 stage 产出的 **artifact**

### Step 2：Schema Validation

首先执行不可协商的检查：
- 根据对应 JSON schema（`schemas/artifacts/<name>.schema.json`）验证 artifact
- 如果 schema validation 失败，这是 **critical** finding，必须立即修复，不得继续

### Step 3：按 Focus Items Review

针对 manifest 中每个 `review_focus` 项：
1. 按该具体 criterion 评估 artifact
2. 分配 severity：
   - **critical**：继续前必须修复。artifact 已损坏、不完整或存在危险错误。**按 CHAI rules，每个 critical finding 都必须带 `proposed_fix`（具体替换文本、精确字段值或具体纠正动作）。没有 proposed fix 的 critical finding 降级为 `investigation`。**
   - **suggestion**：应修复。能显著提升质量但不阻塞进度。**Suggestions 必须带 `proposed_change`，说明如何改进。**
   - **nitpick**：可以修复。小型 polish，属于 nice-to-have。可以没有 proposed change。
   - **investigation**：真实顾虑，但无法定位修复方式。暴露给下一轮；不要因此阻塞。
3. 写出具体、可执行的 finding（不要模糊）

**好 finding：** “Section 3 narration is 180 words for a 10-second window — that's 1080 wpm, impossible to speak. Cut to 25 words.”
**坏 finding：** “Script might be too long.”

### Step 4：对 Playbook 做交叉检查

如果 style playbook 处于 active 状态，验证：
- [ ] Color references 匹配 playbook palette
- [ ] Transition types 位于 playbook 允许集合内
- [ ] Pacing rules 被遵守（min / max durations）
- [ ] Asset descriptions 包含 playbook style cues
- [ ] Quality rules 未被违反

每个 violation 都是 **suggestion** severity finding。

### Step 5：评估 Success Criteria

针对 manifest 中每个 `success_criteria` 项：
- criterion 是否满足？（yes / no / partial）
- 如果不满足，创建 **critical** finding

### Step 6：做出决策

按 severity 统计 findings：

| 场景 | 动作 |
|----------|--------|
| 0 个 critical，有任意 suggestions / nitpicks | **Pass**：进入 checkpoint。记录 suggestions。 |
| 1+ 个 critical findings | **Revise**：修复所有 critical findings，然后重新 review（最多 2 轮）。 |
| 2 轮 revision 后仍有 critical | **Pass with warnings**：仍继续推进，记录未解决问题。绝不无限阻塞。 |

### Step 7：记录 Review

review 结构如下：

```
## Review: [stage_name] — Round [N]

**Decision:** PASS / REVISE / PASS_WITH_WARNINGS

### Findings

1. [CRITICAL] Title of finding
   - Description: What's wrong
   - Action: What to fix
   - Status: pending / fixed / accepted / deferred

2. [SUGGESTION] Title of finding
   - Description: What could be better
   - Action: How to improve
   - Status: pending / accepted / deferred

### Summary
- Critical: N (N fixed)
- Suggestions: N
- Nitpicks: N
- Playbook violations: N
- Success criteria met: N/M
```

## 关键原则

1. **具体，不模糊。** “The hook is weak” 没有用。“The hook asks a question but doesn't create urgency — try leading with the surprising stat from key_point #2” 才可执行。

2. **Critical 就是 critical。** 不要抬高 severity。缺少 schema field 是 critical。段落稍微啰嗦是 suggestion。逗号拼接是 nitpick。

3. **最多两轮。** 目标是交付，不是完美。两轮 revision 后，pass with warnings 并继续。完美主义会杀死 pipelines。

4. **Review artifact，不 review process。** 你检查的是输出，不是生成方式。如果 brief 有说服力，Agent 使用了不寻常方法也没关系。

5. **Playbook is law。** 如果 playbook 说 “no more than 3 colors on screen”，这不是建议，而是约束。violations 必须始终标记。

## Stage-Specific Review Guidance

| Stage | 最重要的内容 |
|-------|-----------------|
| research | Source diversity、claim verifiability、visual reference quality |
| proposal | Delivery promise clarity、renderer family 和 render runtime selection、music / voice plan、decision log started |
| idea | Hook uniqueness、research depth、angle diversity |
| script | Timing accuracy、narrative arc、enhancement cue density |
| scene_plan | Full coverage、visual variety、asset feasibility、slideshow risk score |
| assets | File existence、style consistency、budget adherence |
| edit | Timeline coverage、audio sync、subtitle presence、delivery promise compliance |
| compose | Playability、duration accuracy、audio quality、pre-compose validation pass |
| publish | SEO quality、metadata completeness、export packaging |

## Reference Alignment Review

当存在 VideoAnalysisBrief（reference-driven production）时，在**每个 stage** 运行。

### 检查项：

1. **Grounding check：** 输出是否引用了 VideoAnalysisBrief 中的具体 findings，还是在编造 reference？
   - Proposal 提到 “fast pacing”，但 reference pacing_style 是 “slow_contemplative” → **CRITICAL**
   - Script 声称 reference 有 narration，但 VideoAnalysisBrief 显示没有 narration → **CRITICAL**

2. **Differentiation check：** 每个 concept / scene 是否与 reference 有清晰创意差异，还是复制？
   - Proposal 是 reference 的 carbon copy（同主题、同结构、同 treatment）→ **CRITICAL**
   - 每个 concept 至少一个元素必须区别于 reference；如果较弱则标为 **SUGGESTION**
   - brief 中的 creative differentiation seeds 应反映在 proposals 中

3. **Promise preservation：** 用户表示喜欢 reference 的元素，是否仍保留在输出中？
   - 用户说 “I love the pacing”，但 scene_plan 中 scenes 时长翻倍 → **SUGGESTION**
   - 用户说 “keep the hook style”，但 script 使用了不同 hook → **SUGGESTION**

4. **Cost alignment：** cost estimate 是否仍准确，还是 scope creep？
   - 如果 actual spend 在没有重新获得用户批准的情况下超过 estimate 30% → **CRITICAL**
   - 如果新增了 approved proposal 之外的 assets → **SUGGESTION**

### Severity：
- 关于 reference video 的事实错误：**CRITICAL**
- 没有 differentiation 的 carbon copy：**CRITICAL**
- 弱 differentiation（只有表面变化）：**SUGGESTION**
- 未遵守用户偏好：**SUGGESTION**
- Cost drift >30%：**CRITICAL**

## Slideshow Risk Review

在 **scene_plan** 和 **edit** stages 运行。使用 `lib/slideshow_risk.py` 计算 score。

### 在 scene_plan stage：
1. 计算 `score_slideshow_risk(scenes, renderer_family=renderer_family)`
2. 如果 verdict 是 **"fail"**（average ≥ 4.0）：**CRITICAL**，scene plan 必须修订后才能继续
3. 如果 verdict 是 **"revise"**（average ≥ 3.0）：**SUGGESTION**，标记 score ≥ 3.5 的具体 dimensions
4. 如果 verdict 是 **"strong"** 或 **"acceptable"**：在 review summary 中记录，不需要 finding

### 在 edit stage：
1. 使用完整 edit_decisions 重新计算：`score_slideshow_risk(scenes, edit_decisions, renderer_family)`
2. 使用相同阈值；如果 edit stage 让情况变差（score 高于 scene_plan），标记

### 各 dimension 的标记方式：
| Dimension | score ≥ 3.0 时怎么说 |
|-----------|------------------------------|
| repetition | “X scenes use the same layout/shot size — vary the visual grammar” |
| decorative_visuals | “X scenes have no stated purpose (no information_role or shot_intent)” |
| weak_motion | “Camera movement exists but lacks narrative justification” |
| weak_shot_intent | “X scenes are missing shot_intent — why does this frame exist?” |
| typography_overreliance | “X% of scenes are text/stat cards — video feels like animated slides” |
| unsupported_cinematic_claims | “Claiming cinematic but missing hero moments / lighting / movement” |

## Decision Log Review

proposal 之后的**每个 stage** 都运行。decision log（`schemas/artifacts/decision_log.schema.json`）是累计 audit trail。

### 检查项：
1. **Existence**：checkpoint 是否引用了 `decision_log_ref`？proposal stage 之后如果没有，标为 **SUGGESTION**。
2. **Coverage**：每个重大选择是否都有 entry？必须记录的关键 decisions：
   - Provider selection（选择哪个 image / video / audio tool，以及原因）
   - Style / playbook selection
   - Music track selection
   - Voice selection
   - Renderer family selection
   - 任何 fallback 或 downgrade（例如 motion → still）
3. **Quality**：每个 decision 应具备：
   - 至少 2 个 `options_considered`（不能只有被选中的那个）
   - 非模板化的 `reason`（“best option” 不是理由）
   - 正确的 `confidence`（0.0–1.0）；如果全部都是 1.0，要标记为不现实
4. **User visibility**：标记 `user_visible: true` 的 decisions 应该是用户真的关心的内容，而不是内部 routing

### Severity：
- proposal 之后缺少 decision log：第一次为 **SUGGESTION**；如果 edit stage 仍缺少则为 **CRITICAL**
- decision 只考虑了 1 个 option：**SUGGESTION**，“Log rejected alternatives for auditability”
- 所有 decisions 的 confidence 都是 1.0：**SUGGESTION**，“Unrealistic confidence — at least provider selection involves tradeoffs”

## Creative Differentiation Review

在 **scene_plan** 和 **edit** stages 运行。防止 “every video looks the same” 失败模式。

### 检查项：
1. **Variation check**（仅 scene_plan）：使用 `lib/variation_checker.py` → `check_scene_variation(scenes)`。
   - 如果 verdict 是 “poor”（score ≤ 2）：**CRITICAL**，“Scene plan lacks variety: [list violations]”
   - 如果 verdict 是 “fair”（score ≤ 3）：**SUGGESTION**，记录 checker 给出的具体 suggestions

2. **Playbook alignment**：active playbook 是否适合当前内容？
   - Cinematic trailer 使用 “clean-professional” theme → 标记 mismatch
   - Educational explainer 在用户未要求时使用 “anime-ghibli” theme → 标记

3. **Shot language completeness**（scene_plan）：
   - 每个 scene 至少应有 `shot_size` 和 `shot_intent`
   - Hero moments 应有完整 shot_language（全部 6 个字段）
   - 空 shot_language 的 scenes 标为 **SUGGESTION**

4. **Renderer family match**（edit stage）：
   - edit_decisions 中的 `renderer_family` 是否匹配 proposal 中设置的值？
   - 如果变更且 decision log 中没有记录原因 → **CRITICAL**

5. **Render runtime match**（edit 和 compose stages）：
   - edit_decisions 中的 `render_runtime` 必须匹配 `proposal_packet.production_plan.render_runtime`
   - 如果变更且 decision_log 中没有记录 `render_runtime_selection` decision → **CRITICAL**
   - 在 compose stage，`final_review.checks.promise_preservation.runtime_swap_detected` 必须为 `false`。如果为 `true` 且没有已批准的 `render_runtime_selection` decision → **CRITICAL**
   - compose 时 runtime 不可用不能作为 silent swap 的借口；正确行为是升级、获得批准、记录 decision，然后再运行。

6. **Runtime selection presented both options**（proposal stage，MANDATORY）：
   - 查询 `video_compose.get_info()["render_engines"]`。如果 `remotion` 和 `hyperframes` 都显示 `True`，`decision_log` 中的 `render_runtime_selection` decision 必须在 `options_considered` 中包含两个 runtimes。
   - 当机器上两个 runtimes 都可用时，`render_runtime_selection` 只在 `options_considered` 中包含一个 runtime → **CRITICAL**。Agent 静默采用默认值，用户没有看到替代选项。重新打开 proposal stage，并展示两者。
   - 如果只有一个 runtime 可用，`options_considered` 仍必须列出不可用项，并带 `rejected_because: "runtime not available on this machine"`；否则 audit trail 会丢失“选择受约束，而非自由裁量”的事实。
   - 按 AGENT_GUIDE.md > “Present Both Composition Runtimes (HARD RULE)”：pipeline 建议的 “default” runtime 不是跳过用户沟通的许可证。

## Delivery Promise Review

在 **edit** 和 **compose** stages 运行。使用 `lib/delivery_promise.py`。

### 在 edit stage：
1. 从 proposal packet 或 edit_decisions metadata 中提取 delivery promise
2. 对 resolved cut list 运行 `promise.validate_cuts(cuts)`
3. 如果 `valid` 为 False：**CRITICAL**，“Delivery promise violation: [violations]”
4. 检查 `motion_ratio`：如果 motion-led promise 的 motion cuts < 50%，即使技术上 valid 也要标记

### 在 compose stage：
1. `video_compose.py` 中的 `_pre_compose_validation()` 会自动强制执行
2. Review 应确认 validation 未被绕过（检查 render report 中的 warnings）
3. 如果 motion-led promise 在 motion ratio 过低的情况下仍 render 成功，标为 **SUGGESTION**

## Source Understanding Review

当存在 user-supplied media files 时，在 **research** 和 **proposal** stages 运行。

### 检查项：
1. **Existence**：如果项目提供了 user-supplied files，是否存在 `source_media_review` artifact？
   - 如果 user media 存在但没有 `source_media_review`：**CRITICAL**，“User supplied media but the agent did not inspect it before planning. Run `lib/source_media_review.review_source_media()` before proceeding.”
2. **Actual inspection**：每个 file entry 是否都有 `reviewed: true` 和非空 `technical_probe`？
   - 如果缺少 `reviewed` 或 `technical_probe` 为空：**CRITICAL**，“The source_media_review claims review but contains no probe data. The file was not actually inspected.”
3. **Planning reflection**：`planning_implications` 是否出现在 proposal 的 production plan 中？
   - 如果识别出 quality risks（例如 low resolution、mono audio）但 proposal 未提及：**SUGGESTION**，“Source media has quality risks that the proposal does not address.”
4. **Content accuracy**：plan 是否依赖 source media 实际不包含的内容？
   - 例如 plan 假定有 interview dialogue，但 `transcript_summary` 显示无 speech：**CRITICAL**，“Plan assumes dialogue but source media contains no speech.”
5. **No hallucinated content**：Agent 不得仅根据文件名推断无支撑内容。如果 `content_summary` 写 “interview footage”，但 probe 只显示 3 秒静音视频，标为 **CRITICAL**。

### Severity：
- user files 存在时缺少 `source_media_review`：proposal stage 为 **CRITICAL**
- 未 review 的 files（无 probe）：**CRITICAL**
- Plan 未反映 quality risks：**SUGGESTION**
- Plan 假定 source 中不存在的内容：**CRITICAL**

## Final Self-Review Review

在 **compose** 和 **publish** stages 运行。确保 Agent review 了实际 rendered output。

### 在 compose stage：
1. **Existence**：`render_report` 旁边是否存在 `final_review` artifact？
   - 如果缺失：**CRITICAL**，“Compose produced a render_report but no final_review. The agent must inspect the rendered output before presenting it.”
2. **Status check**：`final_review.status` 是什么？
   - `pass` → OK，继续
   - `revise` → Agent 应在展示前修复问题。如果 pipeline 仍继续：**CRITICAL**，“Self-review found revise-worthy issues but the agent presented anyway.”
   - `fail` → pipeline 不得继续。如果继续了：**CRITICAL**
3. **Check completeness**：全部 5 个 required checks 都必须有数据：
   - `technical_probe` 必须显示有效 container，且 duration / resolution 合理
   - `visual_spotcheck` 必须有 `frames_sampled >= 4`
   - `audio_spotcheck` 必须报告 narration / music presence
   - `promise_preservation` 必须确认 `delivery_promise_honored`
   - `subtitle_check` 必须报告 presence / absence
   - 任何 check 缺少数据：**SUGGESTION**，“Self-review check [X] has incomplete data”
4. **Promise preservation**：如果 `promise_preservation.silent_downgrade_detected` 为 true：**CRITICAL**，“Self-review detected silent downgrade from motion-led to still-led.”

### 在 publish stage：
1. 验证 `final_review` 已作为 required artifact 传递
2. 如果 `final_review.status` 不是 `pass`：**CRITICAL**，“Cannot publish with a non-passing self-review”
3. 如果 `final_review.issues_found` 非空且 `recommended_action` 不是 `present_to_user`：**SUGGESTION**，“Self-review found issues; verify they were resolved before publishing”

## Composition Authoring Mode Review

templated → atelier inversion（`AGENT_GUIDE.md` → “Composition Authoring Mode” + `skills/meta/bespoke-composition.md`）是 governance，不是建议。reviewer 是执行点：没有这些检查，下一个 Agent 会悄悄回到库存 cut-schema，每个视频又开始长得一样。

### 在 proposal stage：
1. `decision_log` 必须包含一个 `composition_mode` decision，且有 `options_considered: ["templated","atelier"]`，并包含与 brief 绑定的真实 `selected` 理由。
   - 完全缺少 `composition_mode` decision：**CRITICAL**，“Proposal missing composition_mode choice. Atelier vs templated is a mandatory presented decision (see AGENT_GUIDE.md → Composition Authoring Mode).”
   - decision 只记录了一个 option considered：**CRITICAL**，“composition_mode decision logged without presenting both templated and atelier alternatives.”
2. 对于 **hero work**（brief 标记为 marketing / launch / brand piece / explainer-with-quality-bar / 任何质量是重点的单交付物），如果 `selected == "templated"`：**CRITICAL**，“Hero brief locked composition_mode='templated'. Default is atelier per doctrine; templated requires an explicit reason in `decision_log.<entry>.reason` (e.g. localization variant, batch, time-boxed draft).” 只有 reason 字段命名了被认可的例外时才可 suppress。
3. 如果 `composition_mode == "atelier"`，但 `proposal_packet` 缺少 `art_direction` declaration（palette、type、motion、signature device）：**CRITICAL**，“Atelier proposal missing art-direction commitment. Per `skills/meta/bespoke-composition.md` step 1, art direction must be written down *before* authoring scenes.”

### 在 scene_plan / edit stage（当 composition_mode == "atelier"）：
1. `edit_decisions.composition_mode` 必须等于 `"atelier"`，并且 `edit_decisions.bespoke.{entry, composition_id, art_direction}` 都必须设置。
   - 缺少 `entry` / `composition_id` 任一项：**CRITICAL**，“Atelier compose contract incomplete; render will be rejected by `_render_via_atelier`.”
   - 缺少 `art_direction`：**CRITICAL**，“Atelier without an art-direction declaration; reviewer cannot evaluate distinctness.”
2. `edit_decisions.cuts` 中出现任何库存 `cut.type` scene-types（`text_card`、`stat_card`、`bar_chart`、`kpi_grid`、`callout`、`comparison`、`hero_title`、`terminal_scene`、`anime_scene`、`progress_bar`、`pie_chart`、`line_chart`）：**CRITICAL**，“Atelier piece reaches for stock cut.type {name}. Hand-author the scene; the stock registry is a mechanics codex, not a parts bin (`skills/meta/bespoke-composition.md`).”

### 在 compose stage（当 composition_mode == "atelier"）：
1. compose stage 的 `final_review.checks.atelier` block 必须存在。如果缺失：**CRITICAL**，“Atelier render skipped doctrine checks — `_render_via_atelier` returned without `atelier` checks; investigate tool wiring.”
2. 如果 `final_review.checks.atelier.stock_reuse_detected == true`：**CRITICAL**，“Stock-registry import inside bespoke project ({offending_imports[0].file} → {offending_imports[0].import}). Hand-author the scene; do not import from the stock src/.”
3. 如果 `final_review.checks.atelier.art_direction_declared == false`：**CRITICAL**，“Atelier render with no art-direction declaration. Set `edit_decisions.bespoke.art_direction` before re-render.”
4. **Scene distinctness：no hero-component spine（mandatory record）。** 每个 scene 采样一个代表帧（例如每个 `props.sections[i]` 的 mid-window），并在 review record 中回答：
   - *每个 scene 是否都有不同的 primary visual subject？* 如果两个或更多 scenes 共享 primary visual（同一个 hero element 只是换 caption，例如一直不离场的 candle、每个 beat 都出现的 browser frame、作为 scaffolding 的 score ring）：**CRITICAL**，“Hero-component spine detected: scenes {ids} share their primary visual subject. Per `skills/meta/bespoke-composition.md` step 1.5, each scene must earn its own composition; the signature device belongs to one climactic beat, not as scaffolding. Re-plan the affected scenes.”
   - *`art_direction` 中命名的 signature device 是否实际出现在至少一个 beat 中？*（否 ⇒ CRITICAL，重新 author 或更新 declaration，使其匹配实际构建内容）
   - *signature device 是否出现在**大多数** beats 中？*（是 ⇒ CRITICAL，见上方 hero-component-spine；signature 应保持稀缺）
   该检查不能静默跳过；缺少逐 scene inventory 记录本身就是 **CRITICAL**（“scene_distinctness inventory not recorded”）。
5. **Captions / on-screen text dedup（mandatory check）。** 比较 active caption text 与同一时间窗口内渲染的任何 on-screen text：
   - 如果它们是相同内容（caption 复述 scene 的 title / headline，而 narration 已经在朗读）：**CRITICAL**，“Caption duplicates on-screen text at {t}s ('{text}'). Decide once per piece whether captions add meaning (numbers, names, translations) or are accessibility subtitles; do not do both for the same line. Either clear `captions=[]` for these scenes or remove the redundant on-screen SerifLine.”
6. **Distinctness review（human-judged，mandatory）。** 批准 render 前，reviewer 必须在 review record 中明确回答：
   - *“Could this video be any other product's video?”*（yes ⇒ CRITICAL，重新 author art direction）
   - *“Does its visual language reuse a look from a prior piece I've made?”*（yes ⇒ CRITICAL，重新 author）
   Distinctness 属于 taste-call，工具无法自动化；reviewer 缺席这个问题本身就是 **CRITICAL** finding（“distinctness review not recorded”）。

### 在 publish stage（当 composition_mode == "atelier"）：
1. 上述六项 atelier compose-stage checks（存在 `atelier` block、stock_reuse、art_direction_declared、scene_distinctness、captions / text dedup、human distinctness review）必须在 review record 中显示为 `resolved`。任何未解决项都是 **CRITICAL**，“Cannot publish atelier piece with unresolved doctrine or distinctness findings.”
