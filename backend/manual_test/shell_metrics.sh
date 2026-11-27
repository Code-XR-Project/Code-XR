#!/bin/bash
# setup script
greet() {
  local name="$1"
  if [ -z "$name" ]; then
    echo "no name"
  elif [[ "$name" == "root" && -n "$2" ]]; then
    echo "root ${#name}"
  else
    echo "hi $name"
  fi
}

function process {
  for f in "$@"; do
    case "$f" in
      *.txt) echo text ;;
      *.md|*.rst) echo doc ;;
      *) echo other ;;
    esac
    while read -r line; do
      [ -n "$line" ] || continue
    done < "$f"
  done
  cat <<EOF2
if this is not code
EOF2
  echo "$(ls "$3")" # comment
}

echo done
