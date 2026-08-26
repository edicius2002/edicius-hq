#!/usr/bin/env bash
#
# Delete local branches whose work is already in main, and forget worktrees
# whose directory is gone. Run after a PR merges.
#
# Squash merges are why this cannot be `git branch --merged`. A squash rewrites
# the branch's commits into one new commit with a different sha, so the branch
# is never an ancestor of main and `--merged` never lists it. Every branch this
# repository merged on 2026-08-21 was in that state.
#
# The test used instead is git's own: build a temporary commit carrying the
# branch's tree on top of its merge base with main, then ask `git cherry`
# whether main already holds an equivalent patch. A `-` means it does. That
# compares what the branch *changed* rather than which commits it has, which is
# exactly the question a squash makes hard.
#
# Refuses to touch main, the branch checked out here, or any branch checked out
# in a worktree (git would refuse that last one anyway).

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

MAIN=main
git show-ref --verify --quiet "refs/heads/$MAIN" || exit 0

git fetch origin --prune --quiet 2>/dev/null

current=$(git branch --show-current 2>/dev/null)
pruned=()
kept=()

# Branches checked out in some worktree cannot be deleted; list them once.
checked_out=$(git worktree list --porcelain 2>/dev/null | sed -n 's|^branch refs/heads/||p')

while read -r branch; do
  [ -z "$branch" ] && continue
  [ "$branch" = "$MAIN" ] && continue
  [ "$branch" = "$current" ] && continue
  case " $checked_out " in *" $branch "*) continue ;; esac

  base=$(git merge-base "$MAIN" "$branch" 2>/dev/null) || continue
  tree=$(git rev-parse "$branch^{tree}" 2>/dev/null) || continue

  # A commit that says "the branch's whole diff, applied to the merge base".
  probe=$(git commit-tree "$tree" -p "$base" -m prune-probe 2>/dev/null) || continue

  if git cherry "$MAIN" "$probe" 2>/dev/null | grep -q '^-'; then
    sha=$(git rev-parse --short "$branch")
    if git branch -D "$branch" >/dev/null 2>&1; then
      pruned+=("$branch ($sha)")
    fi
  else
    kept+=("$branch")
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)

git worktree prune 2>/dev/null

if [ ${#pruned[@]} -gt 0 ]; then
  msg="Pruned ${#pruned[@]} merged branch(es): $(printf '%s, ' "${pruned[@]}" | sed 's/, $//')"
  [ ${#kept[@]} -gt 0 ] && msg="$msg. Still unmerged: $(printf '%s, ' "${kept[@]}" | sed 's/, $//')"
  printf '{"systemMessage":%s,"suppressOutput":true}\n' "$(printf '%s' "$msg" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$msg\"")"
fi

exit 0
