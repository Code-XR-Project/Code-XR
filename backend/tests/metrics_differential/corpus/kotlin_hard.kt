package hard

data class Point(val x: Int, val y: Int)

class Grid(private val cells: List<Point>) {
    val size: Int
        get() = cells.size

    fun near(target: Point, radius: Int = 1): List<Point> =
        cells.filter { p -> Math.abs(p.x - target.x) <= radius && Math.abs(p.y - target.y) <= radius }

    fun describe(p: Point?): String {
        val name = p?.toString() ?: "none"
        return when {
            p == null -> name
            p.x > 0 && p.y > 0 -> "first"
            p.x < 0 -> "left"
            else -> "other"
        }
    }

    fun walk(limit: Int): Int {
        var total = 0
        for (i in 0 until limit) {
            if (i % 2 == 0) {
                total += i
            } else {
                while (total > 100) {
                    total -= 10
                }
            }
        }
        return total
    }
}

fun <T> firstOrNull(items: List<T>, predicate: (T) -> Boolean): T? {
    for (item in items) if (predicate(item)) return item
    return null
}
