#!/bin/sh
# Development only (macOS): symlink extension/ into the per-user CEP extensions
# folder so edits are live on the next panel reload. Needs debug mode
# (scripts/enable-debug-mode.sh). Restart Premiere once afterwards.
# Run with --remove to unlink.
set -e
ID="com.codehare.renderhare"
SRC="$(cd "$(dirname "$0")/../extension" && pwd)"
DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DIR/$ID"

if [ -L "$DEST" ]; then rm "$DEST"; echo "Removed link: $DEST"
elif [ -e "$DEST" ]; then echo "$DEST is a real folder (an installed copy?). Remove it first." >&2; exit 1
fi
[ "$1" = "--remove" ] && exit 0

mkdir -p "$DIR"
ln -s "$SRC" "$DEST"
echo "Linked $DEST -> $SRC"
echo "Restart Premiere Pro, then open Window > Extensions > Render Hare."
