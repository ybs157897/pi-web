---
name: rd-cli-auth
description: >
  This skill handles rd-cli authentication: login, logout, and auth status checks.
  rd-cli supports browser SSO authorization (default), JSON mode (for AI agents
  to initiate and the user to confirm in browser), and username/password login
  (for headless environments). Auth credentials are stored AES-256-GCM encrypted
  in ~/.rd-cli/auth.json. Trigger this skill when the user needs to log in to
  rd-cli, log out, check auth status, or troubleshoot authentication issues.
---

# rd-cli 登录认证

处理 rd-cli（研发一站式CLI）的用户认证登录、状态检查和登出操作。

## 前置条件

- rd-cli 已安装（若未安装，走 `rd-cli-setup` skill）
- 拥有大华域账号

## 工作流程

### Step 1: 检查当前认证状态

```bash
rd-cli auth status
```

- 显示工号/姓名/部门 → 已登录，无需操作
- 显示未登录或 token 过期 → 继续 Step 2

### Step 2: 选择登录模式执行

三种登录模式：

| 模式 | 命令 | 适用场景 |
|------|------|----------|
| 交互模式（默认） | `rd-cli auth login` | 桌面环境，用户可直接操作浏览器 |
| JSON 模式 | `rd-cli --json auth login` | AI Agent 发起：命令立即返回 `auth_url`，不阻塞轮询 |
| 单次确认模式 | `rd-cli auth login --verify` | JSON 模式后续：单次查询 pending 授权结果 |
| 账号密码 | `rd-cli auth login -u <域账号>` | SSH/远程终端等无图形界面环境，密码不回显输入 |

**Agent 场景标准流程：**

1. 执行 `rd-cli --json auth login`，向用户展示返回的 `auth_url`
2. 用户在浏览器完成 SSO 授权（5 分钟内有效）
3. 执行 `rd-cli auth login --verify` 确认；若提示仍 pending，让用户确认浏览器操作完成后重试
4. `rd-cli auth status` 验证登录成功

**人类用户在场时：** 直接执行 `rd-cli auth login`（自动开浏览器、阻塞等待、成功即显示用户信息）。

### Step 3: 登出

```bash
rd-cli auth logout
```

清除本地认证缓存（`~/.rd-cli/auth.json`）。

## 常见问题

1. **授权超时**：浏览器需在 5 分钟内完成授权，超时重新发起 `rd-cli auth login`
2. **Token 过期**：重新登录即可刷新
3. **网络不可达**：检查能否访问 `https://aimate.dahuatech.com`；代理环境设置 `HTTP_PROXY` / `HTTPS_PROXY`
4. **登录后无权限**：确认域账号有 mate-proxy 访问权限
