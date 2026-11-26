package hard

object Shapes {
  sealed trait Shape
  case class Circle(r: Double) extends Shape
  case class Rect(w: Double, h: Double) extends Shape

  def area(s: Shape): Double = s match {
    case Circle(r) if r > 0 => math.Pi * r * r
    case Rect(w, h) => w * h
    case _ => 0.0
  }

  def total(shapes: List[Shape]): Double = {
    var sum = 0.0
    for (s <- shapes) {
      if (area(s) > 0 && sum < 1e9) {
        sum += area(s)
      }
    }
    sum
  }

  def names[T](items: Seq[T]): Seq[String] =
    items.filter(_ != null).map(i => i.toString)
}
