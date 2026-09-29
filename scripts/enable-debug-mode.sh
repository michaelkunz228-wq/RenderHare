#!/bin/sh
# Development only (macOS): let Premiere load unsigned CEP extensions (CEP 12/13).
# Release builds are signed .zxp files and don't need this. Restart Premiere afterwards.
set -e
for v in 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
  echo "com.adobe.CSXS.$v PlayerDebugMode = 1"
done
echo "Done. Fully quit and reopen Premiere Pro."
