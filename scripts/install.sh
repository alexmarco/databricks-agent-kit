#!/bin/sh
# Installs databricks-agent-kit from its GitHub Release tarball with npm.
#
#   curl -fsSL https://github.com/alexmarco/databricks-agent-kit/releases/latest/download/install.sh | sh
#
# DAK_VERSION=0.2.0 (or v0.2.0) installs that release instead of the latest one.
# The script only runs `npm install --global`: it installs no Node.js, uses no sudo
# and does not change the PATH.
set -eu

repository="alexmarco/databricks-agent-kit"
minimum_major=22
minimum_minor=18

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js $minimum_major.$minimum_minor or later is required, but node was not found."
command -v npm >/dev/null 2>&1 || fail "npm was not found. Install Node.js with npm and run this script again."

node_version=$(node --version)
node_version=${node_version#v}
node_major=${node_version%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
if [ "$node_major" -lt "$minimum_major" ] || { [ "$node_major" -eq "$minimum_major" ] && [ "$node_minor" -lt "$minimum_minor" ]; }; then
  fail "Node.js $minimum_major.$minimum_minor or later is required, found $node_version."
fi

if [ -n "${DAK_VERSION:-}" ]; then
  version=${DAK_VERSION#v}
else
  command -v curl >/dev/null 2>&1 || fail "curl was not found. Install curl or set DAK_VERSION."
  latest_release_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest") ||
    fail "Could not find the latest release of $repository."
  version=${latest_release_url##*/v}
fi
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "Could not find the latest release of $repository (got \"$version\")." ;;
esac

tarball_url="https://github.com/$repository/releases/download/v$version/databricks-agent-kit-$version.tgz"
printf 'Installing databricks-agent-kit %s with npm...\n' "$version"
npm install --global "$tarball_url" || fail "npm could not install $tarball_url."

if command -v dak >/dev/null 2>&1; then
  printf 'Installed: %s\n' "$(dak --version)"
else
  printf 'Installed, but dak is not on your PATH. Add the global bin directory of npm to it (under "%s").\n' "$(npm prefix --global)"
fi
