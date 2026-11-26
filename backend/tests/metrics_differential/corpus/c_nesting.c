int deep(int a, int b) {
  if (a) {
    for (int i = 0; i < b; i++) {
      while (a > i) {
        a--;
      }
    }
  }
  return a;
}

int flat(int a, int b) {
  if (a && b) {
    return 1;
  }
  if (a) a++;
  if (b) b++;
  return a > b ? a : b;
}

int pick(int a) {
  switch (a) {
    case 1: return 10;
    case 2: return 20;
    default: return 0;
  }
}
