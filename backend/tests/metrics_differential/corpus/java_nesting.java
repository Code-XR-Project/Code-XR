class Nesting {
  void three(boolean a, boolean b) {
    if (a) {
      if (b) {
        if (a && b) {
          System.out.println("x");
        }
      }
    }
  }
}
