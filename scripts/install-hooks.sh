#!/usr/bin/env bash
# install-hooks.sh
# Installs a global git post-commit hook on Linux/macOS/WSL.
# Usage: bash scripts/install-hooks.sh [/path/to/qdrant-mcp]

set -e

MCP_SERVER_DIR="${1:-$(realpath "$(dirname "$0")/..")}" 
TEMPLATE_DIR="$HOME/.git-templates/hooks"

mkdir -p "$TEMPLATE_DIR"

cat > "$TEMPLATE_DIR/post-commit" << EOF
#!/bin/sh
# Auto-ingest changed files into Qdrant RAG after every commit.
MCP_SERVER="$MCP_SERVER_DIR"
REPO_NAME=\$(basename \$(git rev-parse --show-toplevel))
CHANGED_FILES=\$(git diff-tree --no-commit-id -r --name-only HEAD)

if [ -z "\$CHANGED_FILES" ]; then exit 0; fi

for FILE in \$CHANGED_FILES; do
  EXT="\${FILE##*.}"
  case "\$EXT" in
    cs|ts|tsx|js|jsx|md|txt|json|yaml|yml|sql|csproj)
      FULL_PATH="\$(git rev-parse --show-toplevel)/\$FILE"
      if [ -f "\$FULL_PATH" ]; then
        node "\$MCP_SERVER/node_modules/.bin/tsx" "\$MCP_SERVER/scripts/ingest.ts" \\
          --file "\$FULL_PATH" \\
          --repo "\$REPO_NAME" \\
          --branch "\$(git rev-parse --abbrev-ref HEAD)" &
      fi
      ;;
  esac
done
EOF

chmod +x "$TEMPLATE_DIR/post-commit"
git config --global init.templatedir "$HOME/.git-templates"

echo "✅ Global post-commit hook installed at: $TEMPLATE_DIR/post-commit"
echo "✅ git init.templatedir set."
echo ""
echo "For existing repos run: git init  (inside each repo root)"
