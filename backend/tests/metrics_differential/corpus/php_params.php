<?php
function combine($first, $second) {
  if ($first && $second) {
    return $first . $second;
  }
  return $first ?? $second;
}
