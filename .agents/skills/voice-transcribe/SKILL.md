---
name: voice-transcribe
description: "何时用：语音转文本需求（触发词：转录语音、识别录音、把语音转成文字、提取音频内容）。用于转录语音消息/音频文件（.wav, .mp3, .m4a等）为文本，利用 gemini-3.8-flash 多模态能力。"
---

# Voice Transcribe (语音转文本转换器)

本 Skill 用于将语音消息/音频文件转录为文本，调用上游 `gemini-3.8-flash` 模型的多模态音频理解能力完成高精度转换。

## Truth sources
- 源文件：用户上传的本地音频文件或存量音频路径。
- 模型：通过 `antigravity` 网关调用 `gemini-3.8-flash` 音频感知端点。

## Steps
1. 校验文件存在性。
2. 识别音频格式。
3. 调用 `.agents/skills/voice-transcribe/transcribe.py` 发送音频内容。
4. 获取文本响应。

## Calibration examples
- 输入：`"把这段语音转成文字"` + `voice.mp3`
- 输出：音频内容的精确文本记录。

## Verification and report
- 验证：程序输出的文本与音频语意匹配度（由调用 Agent 确认）。
- 报告：转写成功即视为闭环，失败返回错误代码。

## 触发场景
- 用户上传音频文件。
- 用户要求“转录语音”、“把语音转成文字”、“识别录音内容”。

## 使用方法
Skill 内置转录脚本：`.agents/skills/voice-transcribe/transcribe.py`

### 命令行调用：
```bash
python3 .agents/skills/voice-transcribe/transcribe.py <音频文件路径> [--prompt "可选提示词"]
```

### 示例：
```bash
# 转录用户上传的语音文件
python3 .agents/skills/voice-transcribe/transcribe.py /path/to/voice.mp3
```

## 架构说明
- 自动读取网关凭据；
- 优先直连 `antigravity/gemini-3.8-flash` 多模态输入端点。
