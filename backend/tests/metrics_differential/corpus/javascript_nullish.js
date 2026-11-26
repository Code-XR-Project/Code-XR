function orDefault(value, fallback) {
  return value ?? fallback;
}

function chain(obj) {
  if (obj && obj.items) {
    return obj.items.length;
  }
  return 0;
}
