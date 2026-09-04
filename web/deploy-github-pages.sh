#!/usr/bin/env bash
set -euo pipefail

web_dir=/home/rust/workspace/colors/web
target_dir=/home/rust/workspace/rei277hz.github.io/modcam16-hk-palette
node_bin=/home/rust/.local/share/fnm/node-versions/v26.7.0/installation/bin

cd "$web_dir"
PATH="$node_bin:$PATH" npm run build

rm -rf -- "$target_dir"
mkdir -p -- "$target_dir"
cp -a -- "$web_dir/dist/." "$target_dir/"
