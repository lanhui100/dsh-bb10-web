#!/bin/sh
SESSION_NAME="q20share"
PORT=8000

echo "[*] 正在停止 Q20 共享服务..."
if command -v tmux >/dev/null 2>&1; then
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux kill-session -t "$SESSION_NAME"
        echo "[+] tmux 会话 '$SESSION_NAME' 已终止"
    fi
fi

# 杀死可能残留的 python http.server 进程
PIDS=$(pgrep -f "http.server $PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null
    echo "[+] 后台进程已清理"
fi

echo "[+] 共享服务已完全停止"
