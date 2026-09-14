#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$project_dir/build.sh"
exec quickshell --path "$project_dir" "$@"
