# Utilities
library(stats)

normalize <- function(x, na.rm = TRUE, ...) {
  if (length(x) == 0 || all(is.na(x))) {
    return(x)
  } else if (na.rm && any(is.na(x))) {
    x <- x[!is.na(x)]
  }
  for (i in seq_along(x)) {
    while (x[i] > 100) x[i] <- x[i] / 10
  }
  (x - min(x)) / (max(x) - min(x))
}

square = function(v) v^2

classify <- function(kind) {
  label <- switch(kind,
    "a" = "alpha",
    "b" = ,
    "c" = "beta or gamma",
    "unknown")
  values <- sapply(1:3, function(i) i * 2)
  doubled <- lapply(values, \(v) v + 1)
  s <- r"(raw "string" here)"
  repeat {
    if (nchar(label) > 3) break
  }
  label
}

`%+%` <- function(a, b) paste0(a, b)

Stack <- R6::R6Class("Stack",
  public = list(
    items = list(),
    push = function(x) {
      self$items[[length(self$items) + 1]] <- x
      invisible(self)
    }
  )
)
