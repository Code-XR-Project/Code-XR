val values = listOf(1, 2, 3)

fun total(items: List<Int>): Int {
    var sum = 0
    for (item in items) {
        if (item > 0) sum += item
    }
    return sum
}

fun label(n: Int) = if (n > 2) "many" else "few"

println(label(total(values)))
