#!/bin/zsh
# The README still. Run from the repo root:  ./tapes/still.sh
#
# juke draws the cover art with the Kitty graphics protocol, which no headless
# recorder can render — vhs and asciinema both come back with an empty pane.
# So the hero is a real screenshot of a real terminal, and this script pins the
# settings so the next one matches the last one.
#
# Pinned: ghostty, Cascadia Code NF at 19 (from your ghostty config), swatch
# theme spider-verse, 104x34 cells.

set -e
cd "$(dirname "$0")/.."
mkdir -p .github/assets

if ! pgrep -q Music && ! pgrep -q Cider; then
  echo "start Music.app (or Cider) and play something first — the player panel"
  echo "is empty without a current track, and the cover art is the whole point."
  exit 1
fi

echo "opening ghostty at 104x34..."
open -na Ghostty --args --window-width=104 --window-height=34 -e juke

echo
echo "1. let the TUI settle: cover art loaded, browser on the albums tab,"
echo "   a row hovered so the preview pane has something in it"
echo "2. click the ghostty window when the crosshair appears"
sleep 6

screencapture -w -o .github/assets/juke.png
sips --resampleWidth 1600 .github/assets/juke.png >/dev/null

echo
echo "wrote .github/assets/juke.png"
