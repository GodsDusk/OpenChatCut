# OpenChatCut × OpenMontage POC 运行手册

本文说明如何启动并试用 `feat/openmontage-agent-poc` 分支。当前版本是本地最小验证：OpenChatCut 提供原有 Web UI 和工程存储，Prompt、Pipeline 与 Skills 在 OpenChatCut 服务端运行，实际媒体 Tools 从固定版本的 OpenMontage 服务端源码加载。

## 1. 目录和版本

本文默认两个项目位于同一父目录：

```text
/Users/zlsj/Documents/GitHub/aigc/
├── OpenChatCut/
└── modify_motage_open/
```

确认版本：

```bash
cd /Users/zlsj/Documents/GitHub/aigc/OpenChatCut
git branch --show-current

git -C ../modify_motage_open rev-parse HEAD
```

期望输出：

```text
feat/openmontage-agent-poc
b97ad70ff23f9415dc5998569d65959d15df357f
```

如果 OpenMontage 不是这个 commit，请先把它切换或更新到对应的 `main` 版本。不要通过修改 `OPENMONTAGE_SOURCE_COMMIT` 绕过版本不一致，因为 Prompt、Skill 和 Tool 必须来自同一基线。

## 2. 环境要求

- Node.js 24.x。OpenChatCut 的 `package.json` 要求 `>=24 <25`。
- Python 3.10+。
- FFmpeg 和 ffprobe。
- npm、Git。

macOS 可先检查：

```bash
node --version
python --version
ffmpeg -version
ffprobe -version
```

如果使用 nvm，在 OpenChatCut 目录执行：

```bash
nvm use
```

本机 Python 工作统一使用共享环境：

```bash
source /Users/zlsj/Documents/python-global/bin/activate
python --version
```

## 3. 安装依赖

### 3.1 OpenChatCut

```bash
cd /Users/zlsj/Documents/GitHub/aigc/OpenChatCut
npm ci
```

### 3.2 OpenMontage Python Tools

```bash
source /Users/zlsj/Documents/python-global/bin/activate
cd /Users/zlsj/Documents/GitHub/aigc/modify_motage_open
python -m pip install -r requirements.txt
python -m pip install piper-tts
```

### 3.3 OpenMontage Remotion Composer

`video_compose` 需要 OpenMontage 自己的 `remotion-composer`：

```bash
cd /Users/zlsj/Documents/GitHub/aigc/modify_motage_open/remotion-composer
npm install
```

只做现有素材的 FFmpeg 合成时不一定会走 Remotion，但建议安装完整，避免模型选择 Remotion 路径后才报依赖缺失。

## 4. 配置 OpenMontage Runtime

在 OpenChatCut 根目录创建或编辑 `.env.local`。如果文件已经存在，只追加下面的配置，不要覆盖现有 Provider Key。

```env
# Python 私有 Runtime
OPENMONTAGE_PYTHON=/Users/zlsj/Documents/python-global/bin/python

# 用于执行 Hybrid 六阶段编排的大语言模型
# 必须兼容 OpenAI Chat Completions、JSON Object，最好支持 Function Tools。
OPENMONTAGE_MODEL_BASE_URL=https://api.openai.com/v1
OPENMONTAGE_MODEL_API_KEY=替换为实际密钥
OPENMONTAGE_MODEL_NAME=替换为实际模型名

# OpenMontage Tool 源码；仅由服务端 Python Worker 读取
OPENMONTAGE_SOURCE_ROOT=/Users/zlsj/Documents/GitHub/aigc/modify_motage_open
OPENMONTAGE_SOURCE_COMMIT=b97ad70ff23f9415dc5998569d65959d15df357f
```

注意：

- 变量名不能加 `VITE_` 前缀，否则可能进入浏览器环境。
- `OPENMONTAGE_MODEL_BASE_URL` 填服务根地址即可；Runtime 会在末尾补 `/chat/completions`。如果地址已经以 `/chat/completions` 结尾，也可以直接填写完整地址。
- `OPENMONTAGE_TOOL_COMMAND` 默认留空，系统会使用内置私有 Tool Bridge。
- 修改 `.env.local` 后需要重启 `npm run dev`。

## 5. 配置媒体 Provider

OpenMontage Tool 会读取 `modify_motage_open/.env`。首次使用时可以从模板创建：

```bash
cd /Users/zlsj/Documents/GitHub/aigc/modify_motage_open
cp .env.example .env
```

然后只填写需要的 Provider。例如：

```env
# 图像/视频生成
FAL_KEY=
HEYGEN_API_KEY=
RUNWAY_API_KEY=
REPLICATE_API_TOKEN=

# 图片、TTS
OPENAI_API_KEY=
ELEVENLABS_API_KEY=
GOOGLE_API_KEY=

# 素材和音乐
PEXELS_API_KEY=
PIXABAY_API_KEY=
UNSPLASH_ACCESS_KEY=
SUNO_API_KEY=
```

不配置付费 Provider 时，可以先测试“只使用我提供的真实素材，不生成额外 AI 视频或图片”。本地合成仍要求 FFmpeg；需要旁白时可使用已安装的 Piper TTS。

## 6. 启动 Web 项目

```bash
cd /Users/zlsj/Documents/GitHub/aigc/OpenChatCut
source /Users/zlsj/Documents/python-global/bin/activate
nvm use
npm run dev
```

浏览器打开：

```text
http://localhost:5199
```

前端不再需要配置原 OpenChatCut 浏览器 LLM。聊天请求会发往同源的 `/api/agent`，由 Node BFF 启动 Python Runtime。

## 7. 最短试用流程

1. 在 OpenChatCut 创建或打开一个工程。
2. 上传视频、图片或音频素材，等待素材出现在媒体池。
3. 在聊天输入框中用 `@` 引用素材；时间段、时间线 Item 和画布选择也会解析到对应的底层素材。
4. 使用 `Agent` 模式发送生成请求。
5. Runtime 会依次执行 `idea → script → scene_plan → assets → edit → compose`。
6. `idea`、`script`、`scene_plan` 三个阶段会暂停等待确认：
   - 回复“确认”或“继续”：批准当前阶段。
   - 直接输入修改意见：退回当前阶段重新生成。
7. Compose 完成后，服务端校验 MP4 并生成现有 OpenChatCut Proposal。
8. 在原有 Proposal 卡片点击应用，最终视频会作为一个新视频素材和时间线 Clip 加入工程。

建议第一次使用下面这个低成本请求：

```text
请使用我引用的素材制作一条 15 秒、16:9 的产品介绍视频。
只使用现有真实素材，不生成额外 AI 图片或 AI 视频；保留现场声音，加入简洁标题和淡入淡出。
```

生成过程中不要同时修改时间线。服务端会校验工程 revision；如果工程已变化，最终 Proposal 会被拒绝，避免覆盖用户的新编辑。

## 8. Ask 模式

`Ask` 模式只执行 OpenMontage 方案分析，不进入素材生成和最终合成，也不会创建 Proposal。适合先询问：

```text
基于我引用的素材，建议做成什么结构？请说明开头钩子、核心段落和节奏。
```

确认方向后，再切换到 `Agent` 模式生成完整视频。

## 9. 运行数据和产物位置

每次 Run 的内部状态位于：

```text
~/.openchatcut/openmontage-runs/<runId>/.openmontage/runs/<runId>/
├── state.json
├── events.jsonl
├── artifacts/
└── checkpoints/
```

通过校验的最终视频会发布到 OpenChatCut 的媒体目录：

- 未配置 `MEDIA_DIR`：`OpenChatCut/public/media/uploads/`
- 配置了 `MEDIA_DIR`：对应的服务端媒体目录

文件名格式：

```text
openmontage-<runId>.mp4
```

## 10. 常见问题

### `OpenMontage source revision mismatch`

`modify_motage_open` 的 HEAD 与固定基线不一致：

```bash
git -C /Users/zlsj/Documents/GitHub/aigc/modify_motage_open rev-parse HEAD
```

应为：

```text
b97ad70ff23f9415dc5998569d65959d15df357f
```

### `OpenMontage model is not configured`

检查 OpenChatCut `.env.local` 中三个模型变量是否都有值，并重启开发服务器：

```text
OPENMONTAGE_MODEL_BASE_URL
OPENMONTAGE_MODEL_API_KEY
OPENMONTAGE_MODEL_NAME
```

### 模型接口返回 404 或不支持 JSON

确认模型服务提供 OpenAI 兼容的 `/chat/completions`，并支持 `response_format: {"type":"json_object"}`。某些只兼容 Responses API 的地址不能直接用于当前 POC。

### `missing executors: video_compose, audio_mixer`

表示真实 OpenMontage Tool 未通过依赖检查。确认：

- `OPENMONTAGE_SOURCE_ROOT` 正确；
- Python requirements 已安装到 `OPENMONTAGE_PYTHON` 指向的解释器；
- FFmpeg/ffprobe 可执行；
- `modify_motage_open/remotion-composer/node_modules` 已安装。

可在 OpenChatCut 根目录查看两个关键 Tool 的发现结果：

```bash
source /Users/zlsj/Documents/python-global/bin/activate
echo '{"action":"describe","tools":["video_compose","audio_mixer"]}' | \
  python -m server.openmontage_runtime.openmontage_tool_worker
```

结果中的两个 `status` 都应为 `available`。

### 素材被拒绝

POC 只接受当前工程拥有、并通过 OpenChatCut 上传接口保存的媒体。任意本地绝对路径、外部 URL、其它工程的 assetId 都不会转交给 Runtime。

### 最终没有 Proposal

依次检查：

1. 是否误用了 `Ask` 模式；
2. `compose` 是否真的生成了 workspace 内的 MP4；
3. MP4 是否能通过 ffprobe；
4. 生成过程中工程 revision 是否发生变化；
5. 浏览器聊天区是否显示 `run.failed` 的错误信息。

## 11. 当前 POC 边界

- 只迁移 Hybrid 六阶段，不包含 OpenMontage 全部 Pipeline。
- Tools 仍从固定版本的服务端 OpenMontage Source 加载；尚未打包成独立 Worker 镜像。
- 最终结果作为一个完整视频 Clip 加入 OpenChatCut，不映射成可逐层编辑的多轨工程。
- Run 与幂等状态仍保存在单机内存和本地文件中。
- 尚未加入多租户鉴权、队列、额度、计费和逐工具成本确认，不可直接公网 ToC 部署。

