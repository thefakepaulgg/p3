#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for command in tsc bun pi; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

pi_cli="$(readlink -f "$(command -v pi)")"
pi_package_dir="$(dirname "$pi_cli")"
while [[ "$pi_package_dir" != / && ! -f "$pi_package_dir/package.json" ]]; do
  pi_package_dir="$(dirname "$pi_package_dir")"
done
if [[ ! -f "$pi_package_dir/package.json" ]]; then
  printf 'Could not locate the active Pi package from %s.\n' "$pi_cli" >&2
  exit 1
fi

runtime_node_modules="$(cd "$pi_package_dir/../.." && pwd -P)"
if [[ "$pi_package_dir" != "$runtime_node_modules/@earendil-works/pi-coding-agent" ]]; then
  printf 'Could not locate the active Pi package dependencies from %s.\n' "$pi_cli" >&2
  exit 1
fi

created_node_modules_link=false
if [[ ! -e node_modules && ! -L node_modules ]]; then
  ln -s "$runtime_node_modules" node_modules
  created_node_modules_link=true
elif [[ "$(readlink -f node_modules)" != "$runtime_node_modules" ]]; then
  printf 'Existing %s/node_modules does not match the active Pi runtime at %s.\n' "$PWD" "$runtime_node_modules" >&2
  exit 1
fi
cleanup() {
  if [[ "$created_node_modules_link" == true ]]; then
    rm -f node_modules
  fi
}
trap cleanup EXIT

tsc -p tsconfig.extensions.json
bun test --verbose ./extensions/github-pr-watch.test.ts ./extensions/claude-connectors.test.ts ./extensions/claude-connectors-auth.test.ts ./extensions/advisor ./extensions/telegram-notify ./extensions/tutor-mode ./extensions/routing ./extensions/workflows
pi --list-models >/dev/null
