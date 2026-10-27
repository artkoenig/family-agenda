#!/usr/bin/env bash
# Installs poppler and Tesseract with its German model in Claude Code cloud sessions, so that the
# PDF tests in packages/adapters run there instead of being skipped. Does nothing where they are
# present, or outside a cloud session.
set -euo pipefail

if command -v pdftotext >/dev/null && command -v pdftoppm >/dev/null && command -v tesseract >/dev/null \
  && tesseract --list-langs 2>&1 | grep -x deu >/dev/null; then
  exit 0
fi

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

sudo=""
if [ "$(id -u)" -ne 0 ]; then sudo="sudo"; fi
$sudo apt-get update -qq
$sudo apt-get install -y -qq --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-deu >/dev/null
