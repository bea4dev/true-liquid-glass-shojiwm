#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
shader_baker="${QSB:-}"
if [[ -z "$shader_baker" ]]; then
    if command -v qsb >/dev/null 2>&1; then
        shader_baker="$(command -v qsb)"
    elif [[ -x /usr/lib/qt6/bin/qsb ]]; then
        shader_baker=/usr/lib/qt6/bin/qsb
    else
        echo 'Qt 6 Shader Tools の qsb が必要です。QSB=/path/to/qsb でも指定できます。' >&2
        exit 1
    fi
fi
"$shader_baker" --qt6 -o "$project_dir/shaders/liquid.frag.qsb" "$project_dir/shaders/liquid.frag"
echo 'LiquidIslandQS: shader built.'
