# install-hooks.ps1
# Installs a global git post-commit hook that triggers rag ingest on every commit.
# Run once from the qdrant-mcp root directory.
#
# Usage:
#   .\scripts\install-hooks.ps1
#   .\scripts\install-hooks.ps1 -McpServerDir "D:\dev\ai\qdrant-mcp\mcp-server"

param(
  [string]$McpServerDir = (Resolve-Path "$PSScriptRoot/../mcp-server")
)

$templateDir = "$env:USERPROFILE\.git-templates\hooks"
New-Item -ItemType Directory -Force -Path $templateDir | Out-Null

$hookPath = "$templateDir\post-commit"

$hookContent = @"
#!/bin/sh
# Auto-ingest changed files into Qdrant RAG after every commit.
# Installed by qdrant-mcp/scripts/install-hooks.ps1

MCP_SERVER="$($McpServerDir -replace '\\', '/')"
REPO_NAME=`$(basename `$(git rev-parse --show-toplevel))`
CHANGED_FILES=`$(git diff-tree --no-commit-id -r --name-only HEAD)`

if [ -z "`$CHANGED_FILES" ]; then
  exit 0
fi

for FILE in `$CHANGED_FILES; do
  EXT="`${FILE##*.}"
  case "`$EXT" in
    cs|ts|tsx|js|jsx|md|txt|json|yaml|yml|sql|csproj)
      FULL_PATH="`$(git rev-parse --show-toplevel)/`$FILE"
      if [ -f "`$FULL_PATH" ]; then
        node "`$MCP_SERVER/node_modules/.bin/tsx" "`$MCP_SERVER/../scripts/ingest.ts" \\
          --file "`$FULL_PATH" \\
          --repo "`$REPO_NAME" \\
          --branch "`$(git rev-parse --abbrev-ref HEAD)" &
      fi
      ;;
  esac
done
"@

Set-Content -Path $hookPath -Value $hookContent -Encoding UTF8

# Mark as executable (needed for git to run it)
git config --global init.templatedir "$env:USERPROFILE\.git-templates"

Write-Host "✅ Global post-commit hook installed at: $hookPath"
Write-Host "✅ git init.templatedir set to: $env:USERPROFILE\.git-templates"
Write-Host ""
Write-Host "For existing repos, run inside each repo:"
Write-Host "  git init  (re-copies hooks from the template)"
Write-Host ""
Write-Host "For new repos, hooks will be copied automatically on git clone/init."
