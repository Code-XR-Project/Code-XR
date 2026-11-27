// Function types, generics, arrows, accessors and optional chaining.
type Mapper<T> = (value: T, index: number) => T;

interface Listener {
  onEvent: (name: string) => void;
  onError?: (error: Error) => boolean;
}

export class Store<T> {
  private items: T[] = [];
  private notify: (count: number) => void = (count) => {
    if (count > 10) {
      console.log(count);
    }
  };

  add(item: T): void {
    this.items.push(item);
    this.notify(this.items.length);
  }

  map(fn: Mapper<T>): T[] {
    return this.items.map((value, index) => fn(value, index));
  }

  find(predicate: (item: T) => boolean): T | undefined {
    for (const item of this.items) {
      if (predicate(item) && item !== undefined) {
        return item;
      }
    }
    return undefined;
  }

  get size(): number {
    return this.items?.length ?? 0;
  }
}

export async function load<K, V>(keys: K[], fetch: (key: K) => Promise<V>): Promise<Map<K, V>> {
  const result = new Map<K, V>();
  for (const key of keys) {
    try {
      result.set(key, await fetch(key));
    } catch (error) {
      if (error instanceof Error) {
        console.warn(error.message);
      }
    }
  }
  return result;
}

export const pick = (flag: boolean) => (flag ? (x: number) => x : (y: number) => -y);

export function classify(code: number): string {
  switch (code) {
    case 1:
    case 2:
      return 'low';
    case 3:
      return code > 2 ? 'mid' : 'odd';
    default:
      return 'high';
  }
}
