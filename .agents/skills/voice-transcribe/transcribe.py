#!/usr/bin/env python3
"""
Voice Transcribe Utility using gemini-3.8-flash via ponyllm gateway.
Supports wav, mp3, m4a, ogg, flac, aac.
"""

import sys
import os
import json
import base64
import argparse
import subprocess
import urllib.request
import urllib.error

def get_api_key():
    key = os.environ.get('PONYLLM_API_KEY')
    if key:
        return key
    cred_file = os.path.expanduser('~/.dsh/.credentials.yaml')
    if os.path.exists(cred_file):
        try:
            import yaml
            with open(cred_file, 'r', encoding='utf-8') as f:
                c = yaml.safe_load(f)
                return c.get('refs', {}).get('PONYLLM_API_KEY')
        except Exception:
            pass
    return None

def convert_to_wav(input_path, output_path):
    cmd = [
        'ffmpeg', '-y', '-i', input_path,
        '-ac', '1', '-ar', '16000', output_path
    ]
    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

def transcribe_audio(file_path, prompt_text="请将这段语音转录为纯文本，准确输出音频内容，不要添加额外的寒暄或多余解释。"):
    if not os.path.exists(file_path):
        print(f"Error: file not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    api_key = get_api_key()
    if not api_key:
        print("Error: PONYLLM_API_KEY not found in environment or ~/.dsh/.credentials.yaml", file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(file_path)[1].lower()
    temp_wav = None
    target_path = file_path
    audio_format = 'wav'

    if ext != '.wav':
        temp_wav = f"/tmp/transcribe_{os.getpid()}_{os.path.basename(file_path)}.wav"
        try:
            convert_to_wav(file_path, temp_wav)
            target_path = temp_wav
        except Exception as e:
            # Fallback if ffmpeg fails: try directly with original format if mp3
            if ext == '.mp3':
                audio_format = 'mp3'
                target_path = file_path
            else:
                print(f"Error converting audio to wav via ffmpeg: {e}", file=sys.stderr)
                sys.exit(1)

    try:
        with open(target_path, 'rb') as f:
            audio_bytes = f.read()
        audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')

        payload = {
            'model': 'antigravity/gemini-3.8-flash',
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': prompt_text},
                        {
                            'type': 'input_audio',
                            'input_audio': {
                                'data': audio_b64,
                                'format': audio_format
                            }
                        }
                    ]
                }
            ],
            'temperature': 0.1
        }

        base_url = os.environ.get('PONYLLM_BASE_URL')
        if not base_url:
            # Check cordis config or default to configured provider gateway
            cordis_path = os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')
            if os.path.exists(cordis_path):
                try:
                    import yaml
                    with open(cordis_path, 'r', encoding='utf-8') as f:
                        patches = yaml.safe_load(f)
                        for p in patches or []:
                            if p.get('name') == '@deepseek-ai/dsh-llm-pi-ai' or p.get('id') == 'llm-pi-ai':
                                base_url = p.get('config', {}).get('providers', {}).get('ponyllm', {}).get('baseURL')
                                if base_url:
                                    break
                except Exception:
                    pass
        if not base_url:
            base_url = 'http://127.0.0.1:8080/v1'

        req_url = f"{base_url.rstrip('/')}/chat/completions"
        req = urllib.request.Request(
            req_url,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json'
            },
            data=json.dumps(payload).encode('utf-8')
        )

        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            text = data['choices'][0]['message']['content'].strip()
            return text
    finally:
        if temp_wav and os.path.exists(temp_wav):
            try:
                os.remove(temp_wav)
            except Exception:
                pass

def main():
    parser = argparse.ArgumentParser(description="Transcribe audio using gemini-3.8-flash")
    parser.add_argument("file", help="Path to audio file")
    parser.add_argument("--prompt", default="请将这段语音转录为纯文本，准确输出音频内容，不要添加额外的寒暄或多余解释。", help="Prompt instructions")
    args = parser.parse_args()

    text = transcribe_audio(args.file, args.prompt)
    print(text)

if __name__ == '__main__':
    main()
