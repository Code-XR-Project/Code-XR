function label(name?: string, fallback: string = "none"): string {
  const value = name ?? fallback;
  return value.length > 0 ? value : fallback;
}

function identity<T extends object>(input: T): T {
  return input;
}

class Box {
  private size = 0;

  get area(): number {
    if (this.size > 0) {
      return this.size * this.size;
    }
    return 0;
  }

  grow(step: number): void {
    this.size += step;
  }
}
