#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_dir="${RUNNER_DIRECTORY:-${project_root}/.data/actions-runner}"
command="${1:-status}"

if [[ ! -f "${runner_dir}/.runner" ]]; then
  echo "Runner is not configured. Run: pnpm runner:setup" >&2
  exit 1
fi

case "${command}" in
  install | start | stop | status | uninstall) ;;
  *)
    echo "Usage: $0 {install|start|stop|status|uninstall}" >&2
    exit 1
    ;;
esac

cd "${runner_dir}"
exec ./svc.sh "${command}"
