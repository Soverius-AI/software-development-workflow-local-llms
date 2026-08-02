#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_dir="${RUNNER_DIRECTORY:-${project_root}/.data/actions-runner}"
github_repository="${GITHUB_REPOSITORY:-}"

if [[ -z "${github_repository}" && -f "${project_root}/.env" ]]; then
  github_repository="$(node --env-file="${project_root}/.env" \
    -e 'process.stdout.write(process.env.GITHUB_REPOSITORY ?? "")')"
fi

repository_url="${RUNNER_REPOSITORY_URL:-${github_repository:-$(git -C "${project_root}" config --get remote.origin.url)}}"

if [[ "${repository_url}" != *://* && "${repository_url}" != git@github.com:* ]]; then
  repository_url="https://github.com/${repository_url}"
fi

if [[ "${repository_url}" == git@github.com:* ]]; then
  repository_url="https://github.com/${repository_url#git@github.com:}"
fi
repository_url="${repository_url%.git}"

if [[ "${repository_url}" != https://github.com/*/* ]]; then
  echo "GITHUB_REPOSITORY must be owner/repository or a GitHub repository URL." >&2
  exit 1
fi

repository="${repository_url#https://github.com/}"
runner_name="${RUNNER_NAME:-$(hostname -s)-implementer}"
runner_labels="${RUNNER_LABELS:-implementer}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) runner_platform="osx-arm64" ;;
  Darwin-x86_64) runner_platform="osx-x64" ;;
  Linux-aarch64 | Linux-arm64) runner_platform="linux-arm64" ;;
  Linux-x86_64) runner_platform="linux-x64" ;;
  *)
    echo "Unsupported runner platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "${runner_dir}"

if [[ ! -x "${runner_dir}/config.sh" ]]; then
  release_json="$(curl --fail --silent --show-error \
    https://api.github.com/repos/actions/runner/releases/latest)"
  runner_version="$(printf '%s' "${release_json}" | node -e '
    let body = "";
    process.stdin.on("data", chunk => body += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.parse(body).tag_name.replace(/^v/, "")));
  ')"
  archive="actions-runner-${runner_platform}-${runner_version}.tar.gz"
  download_url="https://github.com/actions/runner/releases/download/v${runner_version}/${archive}"
  temporary_archive="$(mktemp "${TMPDIR:-/tmp}/github-runner.XXXXXX.tar.gz")"
  trap 'rm -f "${temporary_archive}"' EXIT

  echo "Downloading GitHub Actions runner ${runner_version} for ${runner_platform}..."
  curl --fail --location --show-error --output "${temporary_archive}" "${download_url}"
  tar -xzf "${temporary_archive}" -C "${runner_dir}"
fi

if [[ -f "${runner_dir}/.runner" ]]; then
  echo "GitHub Actions runner is already configured in ${runner_dir}."
  exit 0
fi

registration_token="${RUNNER_TOKEN:-}"
if [[ -z "${registration_token}" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "Install and authenticate GitHub CLI, or provide RUNNER_TOKEN." >&2
    exit 1
  fi
  registration_token="$(gh api \
    --method POST \
    "repos/${repository}/actions/runners/registration-token" \
    --jq .token)"
fi

cd "${runner_dir}"
./config.sh \
  --unattended \
  --replace \
  --url "${repository_url}" \
  --token "${registration_token}" \
  --name "${runner_name}" \
  --labels "${runner_labels}" \
  --work _work

echo "Runner configured. Start it with: pnpm runner:start"
