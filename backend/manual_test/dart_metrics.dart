import 'dart:async';

/* block /* nested */ comment */
class Counter {
  int _value = 0;
  final String label;

  Counter(this.label);

  Counter.named(String l, int start) : label = l {
    _value = start;
  }

  int get value => _value;

  set value(int v) {
    if (v < 0) throw ArgumentError('negative: $v');
    _value = v;
  }

  String describe({bool verbose = false}) {
    final kind = _value > 10 ? 'big' : 'small';
    return verbose ? 'Counter $label is ${_value > 0 ? kind : "empty"}' : kind;
  }

  Future<int> load(String? path) async {
    try {
      final p = path ?? 'default';
      for (var i = 0; i < 3; i++) {
        if (p.isEmpty && i > 0) continue;
      }
      return switch (_value) {
        0 => 1,
        1 || 2 => 2,
        _ => 3,
      };
    } on FormatException {
      return -1;
    } catch (e) {
      return 0;
    }
  }
}

int twice(int x) => x * 2;

void main() {
  final c = Counter('a');
  [1, 2].forEach((n) {
    print(twice(n));
  });
}
