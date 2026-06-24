#!/usr/bin/env bash
# Upload the lode release artifacts (tarball + manifest + checksums) to the
# existing GitHub release. Verifies the release exists first.
#
# Inputs (env): TAG_NAME, ASSET_NAME, GH_TOKEN.
set -euo pipefail

gh release view "${TAG_NAME:?TAG_NAME is required}" >/dev/null
gh release upload "${TAG_NAME}" \
  "dist/${ASSET_NAME:?ASSET_NAME is required}" \
  dist/manifest.json \
  dist/checksums.txt \
  --clobber
