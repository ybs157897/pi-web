---
name: rd-cli-setup
description: >
  This skill should be used when the user needs to install, set up, or update
  the rd-cli command-line tool (研发一站式CLI). rd-cli is an MCP-based R&D pipeline
  CLI for calling business interfaces (WeTrack defect management, task workflows, etc.)
  via mate-proxy. Trigger this skill when the user asks to: install rd-cli,
  check if rd-cli is installed, update/upgrade/rollback rd-cli, set up the
  rd-cli environment, or troubleshoot installation issues.
---

# rd-cli 安装与更新

基于 https://aimate.dahuatech.com/（正式环境）的 rd-cli 安装、更新流程。

## 支持平台

Windows / macOS（arm64、amd64）/ Linux（amd64）。要求 PowerShell 5.1+ 或 bash/zsh，浏览器授权模式需图形界面。

## 工作流程

### Step 1: 检查安装状态

**Windows (PowerShell):**
```powershell
if (Get-Command rd-cli -ErrorAction SilentlyContinue) { rd-cli version } else { Write-Host "NOT_INSTALLED" }
```

**Linux / macOS / Git Bash:**
```bash
if command -v rd-cli &> /dev/null; then rd-cli version; else echo "NOT_INSTALLED"; fi
```

已安装（显示版本号）则跳到 Step 3。

### Step 2: 安装（仅未安装时）

一键安装兼具首次安装与升级功能。

**Windows (PowerShell):**
```powershell
irm https://aimate.dahuatech.com/downloads/scripts/install.ps1 | iex
```

执行策略受限时：
```powershell
PowerShell -ExecutionPolicy Bypass -Command "irm https://aimate.dahuatech.com/downloads/scripts/install.ps1 | iex"
```

**Linux:**
```bash
curl -fsSL https://aimate.dahuatech.com/downloads/scripts/install.sh | bash
```

**macOS:**
```bash
curl -fsSL https://aimate.dahuatech.com/downloads/scripts/install-darwin.sh | bash
```

安装脚本会自动检测平台、备份旧二进制（`.old`）、校验 SHA256、配置 PATH。
默认安装目录：Windows `%LOCALAPPDATA%\Programs\rd-cli`；Linux/macOS `~/.local/bin`（可用 `--install-dir` 覆盖）。

安装后验证：
```bash
rd-cli version
```

### Step 3: 认证检查

```bash
rd-cli auth status
```

已登录（显示工号/姓名/部门）即完成。未登录走 `rd-cli-auth` skill 的登录流程。

### Step 4: 验证业务命令可用

```bash
rd-cli help
```

应显示从 mate-proxy 动态下发的业务命令分组（wetrack、weor、vmp 等）。

## 更新与维护

```bash
rd-cli update --check      # 仅检查新版本
rd-cli update              # 升级到最新版本
rd-cli update --rollback   # 回滚到上一版本
rd-cli refresh             # 强制刷新工具列表（清除缓存并重新拉取，重建命令树）
```

- CLI 启动时后台自动检测新版本，一般无需手动升级
- CLI 升级成功后会自动清除工具缓存并重建命令树
- 工具列表后台每 10 分钟自动检测变化；新增业务命令不出现时用 `rd-cli refresh` 手动刷新

## 常见问题

1. **安装后 rd-cli 不在 PATH 中**：重开终端，或手动添加安装目录（见上方默认目录）到 PATH。
2. **网络不可达**：检查能否访问 `https://aimate.dahuatech.com`；代理环境设置 `HTTP_PROXY` / `HTTPS_PROXY`，或 `RD_CLI_BASE_URL` / `RD_CLI_AUTH_BASE_URL` 覆盖服务地址。
3. **配置文件位置**：
   - `~/.rd-cli/auth.json` — 认证信息（AES-256-GCM 加密）
   - `~/.rd-cli/config.json` — 全局配置（base_url / auth_base_url / check_interval）
   - `~/.rd-cli/cache/tools.json` — 工具列表缓存（TTL 10 分钟）
