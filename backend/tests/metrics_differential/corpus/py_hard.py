"""Decorators, nested functions, lambdas, comprehensions and match."""
import functools


def retry(times):
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            for attempt in range(times):
                try:
                    return fn(*args, **kwargs)
                except ValueError:
                    if attempt == times - 1:
                        raise
            return None
        return wrapper
    return decorator


class Parser:
    """A small parser."""

    def __init__(self, text: str, *, strict: bool = False) -> None:
        self.text = text
        self.strict = strict

    @property
    def size(self) -> int:
        return len(self.text) if self.text else 0

    def tokens(self, /, keep_blank=False):
        words = [w for w in self.text.split() if w or keep_blank]
        key = lambda w: (len(w), w)  # noqa: E731
        return sorted(words, key=key)

    def kind(self, value):
        match value:
            case int() if value > 0:
                return 'positive'
            case int():
                return 'integer'
            case [first, *rest]:
                return 'list'
            case _:
                return 'other'


async def gather(items):
    results = []
    async with lock():
        while items and len(results) < 10:
            item = items.pop()
            with open(item) as handle:
                results.append(handle.read())
    return results


def lock():
    return None
