#!/bin/sh
# Render Hare installer for macOS.
# Put this file in the same folder as RenderHare-<version>.zxp and double-click it.
# (If macOS blocks it: right-click > Open.) It runs Adobe's own plugin
# installer (UPIA), which comes with Creative Cloud.
cd "$(dirname "$0")" || exit 1
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

ZXP="$(ls -1 RenderHare-*.zxp 2>/dev/null | tail -n 1)"
if [ -z "$ZXP" ]; then
  echo "Couldn't find RenderHare-<version>.zxp next to this installer."
  echo "Download it from the Releases page and put it in this folder."
  exit 1
fi
if [ ! -x "$UPIA" ]; then
  echo "Adobe's plugin installer wasn't found. Is Creative Cloud installed?"
  echo "You can also install $ZXP with a ZXP installer app instead."
  exit 1
fi

echo "Installing $ZXP ..."
if "$UPIA" --install "$PWD/$ZXP"; then
  echo
  echo "Done. Restart Premiere Pro, then open Window > Extensions > Render Hare."
  echo "The first time you press Render, allow Premiere under"
  echo "System Settings > Privacy & Security > Accessibility."
else
  echo
  echo "The install didn't succeed. Close Premiere Pro and try again."
  exit 1
fi
