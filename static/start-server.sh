#!/bin/sh
# Q20 Web File Server Launcher (POSIX sh compatible for QNX / BB10)

PORT=8000
SHARE_DIR="/accounts/1000/shared"
SESSION_NAME="q20share"

echo "=========================================="
echo "  BlackBerry Q20 局域网共享服务配置与启动  "
echo "=========================================="

# 1. 检查共享目录
if [ ! -d "$SHARE_DIR" ]; then
    echo "[!] 警告: 未找到 $SHARE_DIR，降级检查当前目录"
    SHARE_DIR="$PWD"
fi
echo "[+] 共享根目录: $SHARE_DIR"

# 2. 检查环境依赖
echo "[*] 检查运行环境..."

# 检查 python3
if ! command -v python3 >/dev/null 2>&1; then
    echo "[-] 未找到 python3，尝试通过 qpkg 自动安装..."
    if command -v qpkg >/dev/null 2>&1; then
        qpkg install python3
    else
        echo "[x] 错误: 未检测到 python3，且 qpkg 不可用。"
        echo "    请先在 Term49 中执行 source /accounts/1000/shared/misc/berrycore/env.sh"
        exit 1
    fi
fi

if command -v python3 >/dev/null 2>&1; then
    PY_VER=$(python3 --version 2>&1)
    echo "[+] Python 环境正常: $PY_VER"
else
    echo "[x] Python3 安装失败，请手动执行 qpkg install python3"
    exit 1
fi

# 检查 tmux
if ! command -v tmux >/dev/null 2>&1; then
    echo "[-] 未找到 tmux，尝试通过 qpkg 自动安装..."
    if command -v qpkg >/dev/null 2>&1; then
        qpkg install tmux
    else
        echo "[!] 未检测到 tmux，将直接在后台使用 nohup 运行"
        USE_TMUX=0
    fi
fi

if command -v tmux >/dev/null 2>&1; then
    echo "[+] tmux 环境正常"
    USE_TMUX=1
else
    USE_TMUX=0
fi

# 3. 检查是否已有服务在运行
if [ "$USE_TMUX" -eq 1 ]; then
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "[!] 服务已在 tmux 会话 '$SESSION_NAME' 中运行！"
        echo "[*] 如需重启，请先执行 sh stop.sh"
    else
        echo "[*] 正在 tmux 中创建后台会话 '$SESSION_NAME' 并启动服务..."
        tmux new-session -d -s "$SESSION_NAME" "cd \"$SHARE_DIR\" && python3 -m http.server $PORT"
    fi
else
    # 降级 nohup 启动
    PID=$(pgrep -f "python3 -m http.server $PORT" 2>/dev/null)
    if [ -n "$PID" ]; then
        echo "[!] 服务已在后台运行 (PID: $PID)"
    else
        echo "[*] 正在通过 nohup 启动后台服务..."
        nohup python3 -m http.server "$PORT" >/dev/null 2>&1 &
    fi
fi

# 4. 验证服务是否成功启动
sleep 2
TEST_RES=0
if command -v curl >/dev/null 2>&1; then
    if curl -s -I "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
        TEST_RES=1
    fi
fi

# 5. 获取本机 IP 地址
IP_LIST=$(ifconfig 2>/dev/null | grep -E "inet [0-9]" | grep -v "127.0.0.1" | awk '{print $2}')
if [ -z "$IP_LIST" ]; then
    IP_LIST=$(ifconfig 2>/dev/null | grep -E "inet " | grep -v "127.0.0.1" | awk '{print $2}')
fi

echo "=========================================="
if [ "$TEST_RES" -eq 1 ]; then
    echo "  [SUCCESS] 共享服务已成功启动！"
else
    echo "  [INFO] 服务启动命令已发出，正在监听端口 $PORT"
fi
echo "=========================================="
echo "电脑浏览器访问地址 (任选手机当前 WiFi 对应 IP):"
for ip in $IP_LIST; do
    echo "  ->  http://${ip}:$PORT"
done
echo ""
echo "共享内容包括: documents, camera, photos, misc 等全部文件夹"
if [ "$USE_TMUX" -eq 1 ]; then
    echo "tmux 管理提示:"
    echo "  - 查看服务控制台: tmux attach -t $SESSION_NAME"
    echo "  - 退出控制台保持后台: 先按 Ctrl+b 然后按 d"
    echo "  - 停止服务: tmux kill-session -t $SESSION_NAME"
fi
echo "=========================================="
