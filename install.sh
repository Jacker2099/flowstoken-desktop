#!/bin/bash
set -e

# ========================================================
#  FlowsToken Desktop macOS 一键极速免弹窗安装脚本
# ========================================================

BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}║              FlowsToken Desktop 客户端一键安装             ║${RESET}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# 1. 检查操作系统
OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
    echo -e "${YELLOW}提示: 当前安装脚本仅适用于 macOS 系统。${RESET}"
    echo "Windows 用户请前往官网下载 .exe 安装包: https://www.flowstoken.com/desktop.html"
    exit 1
fi

# 2. 识别芯片架构
ARCH="$(uname -m)"
VERSION="0.5.60"

if [ "$ARCH" = "arm64" ]; then
    DMG_NAME="FlowsToken-${VERSION}-arm64.dmg"
    ARCH_NAME="Apple Silicon (M1/M2/M3/M4)"
else
    DMG_NAME="FlowsToken-${VERSION}.dmg"
    ARCH_NAME="Intel x86_64"
fi

echo -e "🖥️  检测到系统架构: ${BOLD}${ARCH_NAME}${RESET}"

DOWNLOAD_URL="https://anthropic-api.download/downloads/desktop/${DMG_NAME}?v=20260920-v3"
TMP_DIR="$(mktemp -d /tmp/flowstoken-install.XXXXXX)"
TMP_DMG="${TMP_DIR}/${DMG_NAME}"
MOUNT_DIR="${TMP_DIR}/mount"
mkdir -p "${MOUNT_DIR}"

cleanup() {
    if mount | grep -q "${MOUNT_DIR}"; then
        hdiutil detach "${MOUNT_DIR}" -force -quiet 2>/dev/null || true
    fi
    rm -rf "${TMP_DIR}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 3. 下载 DMG (使用 curl 避免打上浏览器隔离标记)
echo -e "⬇️  正在下载最新版 FlowsToken 客户端 (${VERSION})..."
curl -# -fSL "${DOWNLOAD_URL}" -o "${TMP_DMG}"

# 4. 挂载镜像
echo -e "📦 正在展开安装包..."
hdiutil attach "${TMP_DMG}" -mountpoint "${MOUNT_DIR}" -nobrowse -quiet

# 5. 复制到 /Applications
APP_SRC="${MOUNT_DIR}/FlowsToken.app"
if [ ! -d "${APP_SRC}" ]; then
    echo -e "${YELLOW}错误: 安装镜像中未找到 FlowsToken.app${RESET}"
    exit 1
fi

echo -e "📂 正在安装至「应用程序」文件夹 (/Applications)..."
# 如果已有旧版本，先安全清理
if [ -d "/Applications/FlowsToken.app" ]; then
    # 关闭正在运行的实例
    pkill -f "/Applications/FlowsToken.app/Contents/MacOS/FlowsToken" 2>/dev/null || true
    sleep 0.5
    rm -rf "/Applications/FlowsToken.app"
fi

cp -R "${APP_SRC}" "/Applications/"

# 6. 清理下载隔离标记，确保 100% 零弹窗顺畅启动
xattr -cr "/Applications/FlowsToken.app" 2>/dev/null || true

# 7. 卸载镜像
hdiutil detach "${MOUNT_DIR}" -quiet 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}🎉 安装成功！FlowsToken Desktop 已准备就绪。${RESET}"
echo -e "🚀 正在为您启动 FlowsToken..."
echo ""

# 8. 启动应用
open /Applications/FlowsToken.app
