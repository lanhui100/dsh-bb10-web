---
name: voice-transcribe
description: 语音转文本转换器。用于将语音消息/音频文件（.wav, .mp3, .m4a, .ogg, .flac, .aac, .opus）转录为纯文本，调用 gemini-3.8-flash 模型的多模态音频理解能力完成高精度转换。触发场景包括用户上传语音/音频文件、要求“转录语音”、“把语音转成文字”、“识别录音内容”等。
---

# Voice Transcribe (语音转文本转换器)

本 Skill 用于将语音消息/音频文件（如 `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.aac` 等）转录为纯文本文本，调用上游 `gemini-3.8-flash` 模型的原生多模态音频理解能力完成高精度转换。

## 触发场景
- 用户在会话中上传了语音消息/音频文件（如语音消息、录音、会议音频、微信语音导出等）；
- 用户要求“把这个语音转换成文字”、“听一下这段语音讲了什么”、“转录这个音频文件”；
- 收到附带音频文件的 prompt，且需要提取音频文字内容进行后续处理。

## 使用方法

Skill 内置开箱即用的转录脚本：`.agents/skills/voice-transcribe/transcribe.py`

### 命令行调用：
```bash
python3 .agents/skills/voice-transcribe/transcribe.py <音频文件路径> [--prompt "可选提示词"]
```

### 示例：
```bash
# 转录用户上传的语音文件
python3 .agents/skills/voice-transcribe/transcribe.py /path/to/voice.mp3
```

输出格式为纯文本转录结果。

## 架构说明
- 内部自动读取网关凭据 `PONYLLM_API_KEY`（从环境变量或 `~/.dsh/.credentials.yaml` 读取）；
- 自动检测并转换为适合的音频输入格式；
- 优先直连 `antigravity/gemini-3.8-flash` 多模态输入端点（支持原生 `input_audio`），输出精准的中英文及多语言转写。
