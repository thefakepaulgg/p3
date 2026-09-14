#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/profile-pi-configurations.sh [options]

Run the Phase 1 Pi startup matrix sequentially. Child sessions read the active
Pi config but use --no-session or a copied fixture, so settings and session
history are not changed.

Options:
  --runs N                 measured runs per selected variant (default: 5)
  --warmup-runs N          discarded warm-up runs per warm variant (default: 1)
  --timeout SECONDS        timeout passed to the profiler (default: 10)
  --hold SECONDS           hold after readiness (default: 0)
  --sample-interval SEC    RSS sampling interval (default: 0.05)
  --output-dir DIR         retain JSONL and timing artifacts in DIR
  --agent-dir DIR          Pi agent directory to read (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  --pi-command PATH        Pi executable (default: pi)
  --pi-arg ARG             extra argument passed to every Pi invocation (repeatable)
  --p3-root DIR            p3 package root (default: this repository)
  --third-party-root DIR   package root for third-party-only/full-minus runs (repeatable)
  --session-fixture PATH   session JSONL fixture for the resume variant
  --omit-extension NAME    extension path or package name for full-minus (default: pi-mcp-adapter)
  --variant NAME            select a variant (repeatable; default: all)
  --vmmap                  capture macOS Physical footprint after readiness
  --online                 set PI_OFFLINE=0 instead of the default PI_OFFLINE=1
  -h, --help               show this help

Variants: minimal, resources-no-extensions, full, p3-only,
third-party-only, full-minus-extension, full-cold-cache, full-resume.
EOF
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
runs=5
warmup_runs=1
timeout_seconds=10
hold_seconds=0
sample_interval=0.05
output_dir=
output_dir_is_temporary=true
agent_dir=${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}
pi_command=pi
p3_root=$repo_root
p3_root_physical=$repo_root
session_fixture=
omit_extension=pi-mcp-adapter
offline=true
vmmap=false
pi_args=()
third_party_roots=()
selected_variants=()

while (($#)); do
  case "$1" in
    --runs) runs=$2; shift 2 ;;
    --warmup-runs) warmup_runs=$2; shift 2 ;;
    --timeout) timeout_seconds=$2; shift 2 ;;
    --hold) hold_seconds=$2; shift 2 ;;
    --sample-interval) sample_interval=$2; shift 2 ;;
    --output-dir) output_dir=$2; output_dir_is_temporary=false; shift 2 ;;
    --agent-dir) agent_dir=$2; shift 2 ;;
    --pi-command) pi_command=$2; shift 2 ;;
    --pi-arg) pi_args+=("$2"); shift 2 ;;
    --p3-root) p3_root=$2; shift 2 ;;
    --third-party-root) third_party_roots+=("$2"); shift 2 ;;
    --session-fixture) session_fixture=$2; shift 2 ;;
    --omit-extension) omit_extension=$2; shift 2 ;;
    --variant) selected_variants+=("$2"); shift 2 ;;
    --vmmap) vmmap=true; shift ;;
    --online) offline=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$runs" in ''|*[!0-9]*) printf '%s\n' '--runs must be a positive integer' >&2; exit 2 ;; esac
if ((runs < 1)); then printf '%s\n' '--runs must be a positive integer' >&2; exit 2; fi
case "$warmup_runs" in ''|*[!0-9]*) printf '%s\n' '--warmup-runs must be a non-negative integer' >&2; exit 2 ;; esac

p3_root_physical=$(CDPATH= cd -- "$p3_root" && pwd -P)
profiler="$script_dir/profile-pi-startup.py"
if [[ ! -x "$profiler" ]]; then
  printf 'Profiler is not executable: %s\n' "$profiler" >&2
  exit 2
fi
if ! command -v "$pi_command" >/dev/null 2>&1; then
  printf 'Pi command not found: %s\n' "$pi_command" >&2
  exit 2
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-profile.XXXXXX")
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

if [[ -z "$output_dir" ]]; then
  output_dir="$work_dir/results"
fi
mkdir -p "$output_dir"

session_dir="$work_dir/sessions"
mkdir -p "$session_dir"

# pi list is read-only; its package-root lines are stable across Pi versions.
discover_package_roots() {
  PI_CODING_AGENT_DIR="$agent_dir" "$pi_command" list 2>/dev/null \
    | awk '/^    \// { print $1 }'
}

if [[ -z "$session_fixture" ]]; then
  session_fixture=$(python3 - "$agent_dir/sessions" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
files = list(root.rglob("*.jsonl")) if root.is_dir() else []
if files:
    print(max(files, key=lambda path: path.stat().st_mtime))
PY
)
fi

package_roots=()
while IFS= read -r package_root; do
  [[ -n "$package_root" ]] && package_roots+=("$package_root")
done < <(discover_package_roots || true)

if ((${#third_party_roots[@]} == 0 && ${#package_roots[@]})); then
  for package_root in "${package_roots[@]}"; do
    package_root_physical=$(CDPATH= cd -- "$package_root" 2>/dev/null && pwd -P) || continue
    [[ "$package_root_physical" == "$p3_root_physical" ]] && continue
    third_party_roots+=("$package_root")
  done
fi

# Expand package manifests to individual extension entries so one named
# extension can be removed without disabling the rest of its package.
package_extensions() {
  local package_root=$1
  python3 - "$package_root" "$agent_dir/settings.json" <<'PY'
import fnmatch
import glob
import json
import os
import sys

root, settings_path = sys.argv[1:]
try:
    with open(os.path.join(root, "package.json"), encoding="utf-8") as stream:
        package = json.load(stream)
except (OSError, ValueError):
    raise SystemExit(0)

manifest_entries = [
    value for value in package.get("pi", {}).get("extensions", [])
    if isinstance(value, str)
]
extensions = []
for entry in manifest_entries:
    if entry.startswith(("!", "+", "-")):
        continue
    matches = glob.glob(os.path.join(root, entry)) if "*" in entry or "?" in entry else [os.path.join(root, entry)]
    for match in matches:
        if os.path.isfile(match) and match.endswith((".ts", ".js")):
            extensions.append(os.path.normpath(match))

def matches_pattern(path, pattern):
    pattern = pattern.replace(os.sep, "/")
    relative = os.path.relpath(path, root).replace(os.sep, "/")
    absolute = path.replace(os.sep, "/")
    return any(fnmatch.fnmatchcase(value, pattern) for value in (relative, os.path.basename(path), absolute))

def matches_exact(path, pattern):
    normalized = pattern.removeprefix("./").replace(os.sep, "/")
    relative = os.path.relpath(path, root).replace(os.sep, "/")
    absolute = path.replace(os.sep, "/")
    return normalized in (relative, absolute)

def apply_patterns(paths, patterns):
    includes = [value for value in patterns if not value.startswith(("!", "+", "-"))]
    excludes = [value[1:] for value in patterns if value.startswith("!")]
    force_includes = [value[1:] for value in patterns if value.startswith("+")]
    force_excludes = [value[1:] for value in patterns if value.startswith("-")]
    enabled = list(paths) if not includes else [path for path in paths if any(matches_pattern(path, value) for value in includes)]
    enabled = [path for path in enabled if not any(matches_pattern(path, value) for value in excludes)]
    for path in paths:
        if path not in enabled and any(matches_exact(path, value) for value in force_includes):
            enabled.append(path)
    return [path for path in enabled if not any(matches_exact(path, value) for value in force_excludes)]

manifest_overrides = [value for value in manifest_entries if value.startswith(("!", "+", "-"))]
extensions = apply_patterns(extensions, manifest_overrides)

# Reproduce package-level extension filters from settings.json. This keeps
# explicit -e entries equivalent to normal discovery for filtered packages.
try:
    with open(settings_path, encoding="utf-8") as stream:
        settings = json.load(stream)
except (OSError, ValueError):
    settings = {}
package_name = package.get("name", "")
root_name = os.path.basename(os.path.normpath(root))
for configured in settings.get("packages", []):
    source = configured.get("source", "") if isinstance(configured, dict) else configured
    if not isinstance(source, str):
        continue
    source_tail = source.rstrip("/").rsplit("/", 1)[-1]
    if source_tail.startswith("npm:"):
        source_tail = source_tail[4:].split("@", 1)[0]
    if source not in ("npm:" + package_name, "git:" + package_name) and source_tail != root_name and package_name not in source:
        continue
    if isinstance(configured, dict) and "extensions" in configured:
        filters = configured["extensions"]
        extensions = apply_patterns(extensions, filters) if isinstance(filters, list) and filters else []
    break

for extension in extensions:
    print(extension)
PY
}

extension_is_omitted() {
  local package_root=$1
  local extension=$2
  [[ -z "$omit_extension" ]] && return 1
  if [[ "$omit_extension" == */* ]]; then
    [[ "$extension" == "$omit_extension" ]] && return 0
  else
    [[ "$(basename "$package_root")" == "$omit_extension" ]] && return 0
    [[ "$(basename "$extension")" == "$omit_extension" ]] && return 0
    [[ "$extension" == *"$omit_extension"* ]] && return 0
  fi
  return 1
}

add_package_extensions() {
  local package_root extension
  for package_root in "$@"; do
    [[ -d "$package_root" ]] || continue
    while IFS= read -r extension; do
      [[ -n "$extension" ]] || continue
      if ! extension_is_omitted "$package_root" "$extension"; then
        variant_args+=("-e" "$extension")
      fi
    done < <(package_extensions "$package_root")
  done
}

variant_selected() {
  local candidate=$1 selected
  ((${#selected_variants[@]} == 0)) && return 0
  for selected in "${selected_variants[@]}"; do
    [[ "$selected" == all || "$selected" == "$candidate" ]] && return 0
  done
  return 1
}

summary() {
  local name=$1 jsonl=$2
  python3 - "$name" "$jsonl" <<'PY'
import json
import statistics
import sys

name, path = sys.argv[1:]
records = []
with open(path, encoding="utf-8") as stream:
    for line in stream:
        if line.strip():
            records.append(json.loads(line))
ready = [record["ready_ms"] for record in records if record.get("ready_ms") is not None]

def number(values, function):
    return f"{function(values):.3f}" if values else "NA"

def range_text(values):
    return f"{min(values):.3f}-{max(values):.3f}" if values else "NA"

def standard_deviation(values):
    return statistics.stdev(values) if len(values) > 1 else 0

print(
    f"{name}\truns={len(records)}"
    f"\tready_ms_mean={number(ready, statistics.mean)}"
    f"\tready_ms_stddev={number(ready, standard_deviation)}"
    f"\tready_ms_range={range_text(ready)}"
    f"\troot_rss_kb_max={max((r.get('root_rss_kb', 0) for r in records), default=0)}"
    f"\tprocess_tree_rss_kb_max={max((r.get('process_tree_rss_kb', 0) for r in records), default=0)}"
    f"\tphysical_footprint_kb_max={max((r.get('physical_footprint_kb') or 0 for r in records), default=0)}"
    f"\tmax_process_count={max((r.get('max_process_count', 0) for r in records), default=0)}"
    f"\ttimeouts={sum(1 for r in records if r.get('timed_out'))}"
)
PY
}

run_variant() {
  local name=$1
  local mode=$2
  local iteration run_number total_runs variant_warmups json_file timing_file aggregate_file session_copy profiler_status
  local -a run_args profiler_command
  shift 2
  aggregate_file="$output_dir/$name.jsonl"
  : > "$aggregate_file"

  variant_warmups=$warmup_runs
  [[ "$mode" == cold ]] && variant_warmups=0
  total_runs=$((runs + variant_warmups))
  printf 'Running %s (%d measured, %d warm-up runs)\n' "$name" "$runs" "$variant_warmups"

  if [[ "$mode" == resume && ( -z "$session_fixture" || ! -f "$session_fixture" ) ]]; then
    printf 'Cannot run %s: --session-fixture is missing\n' "$name" >&2
    rm -f "$aggregate_file"
    return 1
  fi

  for ((iteration=1; iteration<=total_runs; iteration++)); do
    run_number=$((iteration - variant_warmups))
    if ((run_number < 1)); then
      json_file="$work_dir/$name-warmup-$iteration.json"
      timing_file="$work_dir/$name-warmup-$iteration.timing.log"
    else
      json_file="$work_dir/$name-$run_number.json"
      timing_file="$output_dir/$name-$run_number.timing.log"
    fi
    session_copy=
    run_args=("$@")
    if [[ "$mode" == resume ]]; then
      session_copy="$work_dir/$name-$iteration-session.jsonl"
      cp "$session_fixture" "$session_copy"
      run_args+=("--session" "$session_copy")
    else
      run_args+=("--no-session")
    fi

    profiler_command=(python3 "$profiler" --timeout "$timeout_seconds" --hold "$hold_seconds" --sample-interval "$sample_interval" --timing-file "$timing_file")
    "$vmmap" && profiler_command+=(--vmmap)
    "$offline" && profiler_command+=(--offline) || profiler_command+=(--online)
    profiler_command+=(-- "${pi_command}")
    if ((${#pi_args[@]})); then
      profiler_command+=("${pi_args[@]}")
    fi
    if ((${#run_args[@]})); then
      profiler_command+=("${run_args[@]}")
    fi

    set +e
    if [[ "$mode" == cold ]]; then
      env PI_CODING_AGENT_DIR="$agent_dir" PI_CODING_AGENT_SESSION_DIR="$session_dir" PI_TIMING=1 JITI_REBUILD_FS_CACHE=1 "${profiler_command[@]}" > "$json_file"
    else
      env PI_CODING_AGENT_DIR="$agent_dir" PI_CODING_AGENT_SESSION_DIR="$session_dir" PI_TIMING=1 "${profiler_command[@]}" > "$json_file"
    fi
    profiler_status=$?
    set -e
    if [[ "$profiler_status" -ne 0 ]]; then
      printf 'Profiler exited %d for %s run %d\n' "$profiler_status" "$name" "$run_number" >&2
    fi
    if ((run_number >= 1)); then
      cat "$json_file" >> "$aggregate_file"
    fi
  done
  summary "$name" "$aggregate_file"
}

if variant_selected minimal; then
  run_variant minimal minimal --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
fi

if variant_selected resources-no-extensions; then
  run_variant resources-no-extensions normal --no-extensions
fi
if variant_selected full; then
  run_variant full normal
fi
if variant_selected p3-only; then
  variant_args=(--no-extensions)
  add_package_extensions "$p3_root"
  run_variant p3-only normal "${variant_args[@]}"
fi
if variant_selected third-party-only; then
  variant_args=(--no-extensions)
  if ((${#third_party_roots[@]})); then
    add_package_extensions "${third_party_roots[@]}"
  fi
  run_variant third-party-only normal "${variant_args[@]}"
fi
if variant_selected full-minus-extension; then
  variant_args=(--no-extensions)
  for extension in \
    "$agent_dir"/extensions/*.ts \
    "$agent_dir"/extensions/*.js \
    "$agent_dir"/extensions/*/index.ts \
    "$agent_dir"/extensions/*/index.js; do
    [[ -f "$extension" ]] || continue
    if ! extension_is_omitted "$agent_dir/extensions" "$extension"; then
      variant_args+=("-e" "$extension")
    fi
  done
  if ((${#package_roots[@]})); then
    add_package_extensions "${package_roots[@]}"
  fi
  run_variant full-minus-extension normal "${variant_args[@]}"
fi
if variant_selected full-cold-cache; then
  run_variant full-cold-cache cold
fi
if variant_selected full-resume; then
  run_variant full-resume resume
fi

printf 'Artifacts: %s\n' "$output_dir"
if "$output_dir_is_temporary"; then
  printf 'Artifacts are temporary; pass --output-dir to retain JSONL and timing-only files.\n'
fi
