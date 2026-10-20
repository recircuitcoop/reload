#!/usr/bin/env bash
# Plan 0028, step 6: the renames outside the repo, run by the owner after 0.4.0 is merged and
# after Reload 0.4.0 has been started once (that first start moves the app's data and secrets).
#
#   bash docs/plans/0028-rename-to-reload.outside.sh           # dry run: prints every change
#   bash docs/plans/0028-rename-to-reload.outside.sh --apply   # makes them, after a backup
#
# Run it from a plain terminal with Claude Code, Claude Desktop, Codex, InnyTypes and Reload
# all quit: it moves the folder Claude Code is keyed on and rewrites their config files.
# Every step checks before it acts and skips itself when already done, so a second run is safe.
# The steps it cannot do (GitHub, DNS, Umami, the sibling repos' contents) are printed at the end.
set -euo pipefail

APPLY=0
if [ "${1:-}" = "--apply" ]; then APPLY=1; fi

OLD_REPO="$HOME/git/innytypes"
NEW_REPO="$HOME/git/reload"
OLD_SECRETS="$HOME/.config/innytypes"
NEW_SECRETS="$HOME/.config/reload"
PROJECTS="$HOME/.claude/projects"
CLAUDE_JSON="$HOME/.claude.json"
CODEX_TOML="$HOME/.codex/config.toml"
ZSHRC="$HOME/.zshrc"
DESKTOP_JSON="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
# Claude Code names a project's memory folder after its path, '/' and '.' replaced by '-'.
slug() { printf '%s' "$1" | tr '/.' '--'; }

say() { printf '%s\n' "$*"; }
fail() { say "STOP: $*"; exit 1; }
# Runs a change, or only shows it in a dry run.
act() {
  if [ "$APPLY" -eq 1 ]; then "$@"; else say "  would run: $*"; fi
}
# Replaces a file's contents with stdin, keeping its mode; a dry run shows the diff instead.
replace_file() {
  local file="$1" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  cat >"$tmp"
  chmod "$(stat -f '%Lp' "$file" 2>/dev/null || stat -c '%a' "$file")" "$tmp"
  if [ "$APPLY" -eq 1 ]; then
    mv "$tmp" "$file"
  else
    say "  would change $file:"
    diff -u "$file" "$tmp" | sed 's/^/    /' || true
    rm -f "$tmp"
  fi
}

say "== Preconditions"
# Anything still running would rewrite these files behind the script, or lose its open state.
for proc in Claude claude codex InnyTypes Reload innytypes reload; do
  if pgrep -x "$proc" >/dev/null 2>&1; then fail "'$proc' is running; quit it first."; fi
done
[ -f "$NEW_SECRETS/mcp_proxy_token" ] ||
  fail "$NEW_SECRETS/mcp_proxy_token is missing: install Reload 0.4.0 and start it once first."
if [ -d "$OLD_REPO" ]; then
  [ ! -e "$NEW_REPO" ] || fail "both $OLD_REPO and $NEW_REPO exist; resolve that by hand."
  [ -z "$(git -C "$OLD_REPO" status --porcelain --untracked-files=no)" ] ||
    fail "$OLD_REPO has uncommitted changes to tracked files."
  [ "$(git -C "$OLD_REPO" worktree list | wc -l | tr -d ' ')" = "1" ] ||
    fail "$OLD_REPO has extra worktrees (loop makers?); remove them by path first."
  grep -q '"version": "0.4.0"' "$OLD_REPO/app/package.json" ||
    fail "$OLD_REPO is not on 0.4.0 yet; merge the rename first."
fi
say "  ok"

if [ "$APPLY" -eq 1 ]; then
  BACKUP="$HOME/reload-rename-backup-$(date +%Y%m%d-%H%M%S).tgz"
  say "== Backup to $BACKUP"
  # The repo itself is in git; this keeps everything else the script touches.
  existing=()
  for p in "$ZSHRC" "$CLAUDE_JSON" "$CODEX_TOML" "$DESKTOP_JSON" "$OLD_SECRETS" \
    "$PROJECTS/$(slug "$OLD_REPO")" "$PROJECTS/$(slug "$OLD_REPO")-app" \
    "$OLD_REPO/.serena/project.yml"; do
    if [ -e "$p" ]; then existing+=("${p#"$HOME"/}"); fi
  done
  tar -czf "$BACKUP" -C "$HOME" "${existing[@]}"
  say "  ok (restore with: tar -xzf $BACKUP -C \$HOME)"
fi

say "== 1. Folder: $OLD_REPO -> $NEW_REPO"
if [ -d "$OLD_REPO" ]; then
  act mv "$OLD_REPO" "$NEW_REPO"
  act git -C "$NEW_REPO" worktree prune
else
  say "  already done"
fi
# Paths inside the repo, wherever it is at this point of a dry or real run.
REPO_NOW="$NEW_REPO"
if [ "$APPLY" -eq 0 ] && [ -d "$OLD_REPO" ]; then REPO_NOW="$OLD_REPO"; fi

say "== 2. Claude Code memory folders"
# Moved, not copied: Claude Code would otherwise start an empty memory for the new path.
for suffix in "" "-app"; do
  from="$PROJECTS/$(slug "$OLD_REPO")$suffix"
  to="$PROJECTS/$(slug "$NEW_REPO")$suffix"
  if [ -d "$from" ] && [ ! -e "$to" ]; then act mv "$from" "$to"; else say "  $to: nothing to move"; fi
done
memory_index="$PROJECTS/$(slug "$NEW_REPO")/memory/MEMORY.md"
if [ "$APPLY" -eq 0 ] && [ -d "$PROJECTS/$(slug "$OLD_REPO")" ]; then
  memory_index="$PROJECTS/$(slug "$OLD_REPO")/memory/MEMORY.md"
fi
if [ -f "$memory_index" ] && grep -q 'git/innytypes/' "$memory_index"; then
  # Only links that point into the repo; what the memories say about the past stays as written.
  sed 's#git/innytypes/#git/reload/#g' "$memory_index" | replace_file "$memory_index"
fi

say "== 3. The headers helper Claude Code calls for the token"
helper="$NEW_SECRETS/mcp-headers.sh"
if [ -f "$helper" ]; then
  say "  already there"
elif [ "$APPLY" -eq 1 ]; then
  cat >"$helper" <<'EOF'
#!/bin/sh
# Prints the Reload MCP bearer header as JSON, read from the token file at call time.
printf '{"Authorization": "Bearer %s"}' "$(cat "$HOME/.config/reload/mcp_proxy_token")"
EOF
  chmod 0700 "$helper"
else
  say "  would write $helper (0700), reading $NEW_SECRETS/mcp_proxy_token"
fi

say "== 4. Claude Code (~/.claude.json): server 'innytypes' -> 'reload', project paths"
if [ -f "$CLAUDE_JSON" ]; then
  jq --arg old "$OLD_REPO" --arg new "$NEW_REPO" --arg helper "$helper" '
    (if .mcpServers.innytypes then
       .mcpServers.reload = (.mcpServers.innytypes | .headersHelper = $helper)
       | del(.mcpServers.innytypes) else . end)
    | (if .projects then .projects |= with_entries(
         if (.key == $old or (.key | startswith($old + "/")))
         then .key = ($new + (.key | ltrimstr($old))) else . end) else . end)
  ' "$CLAUDE_JSON" | replace_file "$CLAUDE_JSON"
fi

say "== 5. Codex (~/.codex/config.toml) and the token variable in ~/.zshrc"
if [ -f "$CODEX_TOML" ]; then
  sed -e "s#\[projects.\"$OLD_REPO\"\]#[projects.\"$NEW_REPO\"]#" \
      -e 's#^\[mcp_servers\.innytypes\]#[mcp_servers.reload]#' \
      -e 's#INNYTYPES_MCP_TOKEN#RELOAD_MCP_TOKEN#g' "$CODEX_TOML" | replace_file "$CODEX_TOML"
fi
if [ -f "$ZSHRC" ] && grep -q 'INNYTYPES_MCP_TOKEN' "$ZSHRC"; then
  sed -e 's#InnyTypes MCP endpoint token#Reload MCP endpoint token#' \
      -e 's#\.config/innytypes/mcp_proxy_token#.config/reload/mcp_proxy_token#g' \
      -e 's#INNYTYPES_MCP_TOKEN#RELOAD_MCP_TOKEN#g' "$ZSHRC" | replace_file "$ZSHRC"
fi

say "== 6. Claude Desktop: server 'innytypes' -> 'reload', token path"
if [ -f "$DESKTOP_JSON" ]; then
  jq '
    if .mcpServers.innytypes then
      .mcpServers.reload = (.mcpServers.innytypes
        | .args |= map(gsub("\\.config/innytypes/"; ".config/reload/")))
      | del(.mcpServers.innytypes)
    else . end
  ' "$DESKTOP_JSON" | replace_file "$DESKTOP_JSON"
fi

say "== 7. Serena's project name"
serena_yml="$REPO_NOW/.serena/project.yml"
if [ -f "$serena_yml" ] && grep -q '^project_name: "innytypes"' "$serena_yml"; then
  sed 's#^project_name: "innytypes"#project_name: "reload"#' "$serena_yml" | replace_file "$serena_yml"
else
  say "  already done"
fi

say "== 8. The code index"
act codebase-memory-mcp cli index_repository --repo-path "$NEW_REPO" --name reload

cat <<EOF

== Done by the script. Left for you, in this order:
  a. Open a new terminal (for RELOAD_MCP_TOKEN), then check the AI apps:
       claude mcp get reload        # expect: Connected
       codex mcp list               # expect: reload
     and open Claude Desktop: its 'reload' server should list the tools.
  b. Delete the old code index: in Claude Code, list_projects, then delete_project on the
     one for $OLD_REPO.
  c. GitHub:   gh repo rename reload -R recircuitcoop/InnyTypes
               git -C $NEW_REPO remote set-url origin https://github.com/recircuitcoop/reload.git
  d. Site:     add DNS for reload.recircu.it and redirect innytypes.recircu.it to it; in Umami
               edit the existing website's domain (keeps its history) rather than adding one.
  e. Sibling repos, each its own change in its own repo (not done here):
       ~/git/innyrize -> ~/git/reload_summarize   (plans only, no code yet)
       ~/git/monty    -> ~/git/reload_mount       (Python package 'monty' -> 'reload_mount')
  f. After Reload has run for a week: delete InnyTypes.app, $OLD_SECRETS and the backup.
EOF
if [ "$APPLY" -eq 0 ]; then say "(dry run: nothing was changed; rerun with --apply)"; fi
