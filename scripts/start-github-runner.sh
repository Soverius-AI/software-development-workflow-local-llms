#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_dir="${RUNNER_DIRECTORY:-${project_root}/.data/actions-runner}"

if [[ ! -f "${runner_dir}/.runner" ]]; then
  echo "Runner is not configured. Run: pnpm runner:setup" >&2
  exit 1
fi

cd "${runner_dir}"
exec ./run.sh
