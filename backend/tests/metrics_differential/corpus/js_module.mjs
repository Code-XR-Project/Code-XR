// ES module: function expressions, arrows, classes, template literals, regex.
export default function main(argv) {
  const pattern = /\{(\w+)\}/g;
  const render = (template, data) => template.replace(pattern, (_, key) => data[key] ?? `{${key}}`);
  return argv.length > 1 ? render(argv[0], { name: argv[1] }) : '';
}

export class Queue {
  #items = [];

  push(item) {
    if (item === undefined || item === null) {
      throw new TypeError(`bad item: ${typeof item}`);
    }
    this.#items.push(item);
  }

  static from(list) {
    const queue = new Queue();
    list.forEach(function (item) {
      if (item) queue.push(item);
    });
    return queue;
  }
}

export const retry = async (fn, times = 3) => {
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === times - 1) throw error;
    }
  }
};
