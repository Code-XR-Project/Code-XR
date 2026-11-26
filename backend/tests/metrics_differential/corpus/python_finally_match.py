def cleanup(handle, mode):
    try:
        handle.write(mode)
    except OSError:
        return False
    finally:
        handle.close()
    match mode:
        case "a":
            return 1
        case "b":
            return 2
        case _:
            return 0


def nested(items):
    for item in items:
        if item:
            while item > 0:
                item -= 1
    return items
