#!/bin/sh
# doc-keeper post-commit 钩子示例：提交后异步通知 doc-keeper A2A 服务刷新知识文档。
#
# 安装（在目标仓库）：
#   cp scripts/doc-keeper-post-commit.sh <repo>/.git/hooks/post-commit
#   chmod +x <repo>/.git/hooks/post-commit
#
# 环境变量（可写进钩子或提交环境）：
#   DOC_KEEPER_URL       A2A 服务地址，默认 http://127.0.0.1:41250
#   DOC_KEEPER_API_KEY   服务设置的 Bearer key；未设置则不带鉴权头
#   DOC_KEEPER_GLOBS     模块关注路径，默认 src/**
#   DOC_KEEPER_DOC_PATH  知识文档路径（相对仓库根），默认 docs/bots/server.md
#
# 设计：fire-and-forget——后台 curl、短超时、失败只记日志，绝不阻塞或影响提交。
# 协议要点（@a2a-js/sdk v1.3.0 原生 JSON-RPC）：方法名 SendMessage（PascalCase），
# 必须带 A2A-Version: 1.0 头（缺省按 0.3 校验会被拒绝），part 用扁平 {data:{...}}。
# API key 只从环境读取，不落日志。

URL="${DOC_KEEPER_URL:-http://127.0.0.1:41250}"
GLOBS="${DOC_KEEPER_GLOBS:-src/**}"
DOC_PATH="${DOC_KEEPER_DOC_PATH:-docs/bots/server.md}"
LOG="${TMPDIR:-/tmp}/doc-keeper-post-commit.log"

# 本次提交触碰的文件（仅供日志；变更检测由 doc-keeper 自己按 updatedStamp 做）。
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | head -20 | tr '\n' ' ')

PAYLOAD=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","messageId":"post-commit-$$-$(date +%s)","parts":[{"data":{"globs":["${GLOBS}"],"knowledgePath":"${DOC_PATH}","mode":"refresh"}}]}}}
EOF
)

AUTH_HEADER=""
if [ -n "${DOC_KEEPER_API_KEY:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${DOC_KEEPER_API_KEY}"
fi

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] post-commit notify: ${DOC_PATH} (changed: ${CHANGED})"
  if [ -n "$AUTH_HEADER" ]; then
    curl -sS --max-time 300 -X POST "$URL/" \
      -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' -H "$AUTH_HEADER" \
      -d "$PAYLOAD"
  else
    curl -sS --max-time 300 -X POST "$URL/" \
      -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
      -d "$PAYLOAD"
  fi
  echo ""
} >> "$LOG" 2>&1 &

exit 0
