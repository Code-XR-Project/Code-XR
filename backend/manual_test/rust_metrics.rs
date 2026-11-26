use std::fmt;

/// A point.
pub struct Point<'a> { x: i32, label: &'a str }

impl<'a> Point<'a> {
    pub fn new(x: i32, label: &'a str) -> Self {
        Point { x, label }
    }

    fn classify(&self, limit: i32) -> &'static str {
        if self.x > limit && limit > 0 {
            "big"
        } else if self.x == 0 {
            "zero"
        } else {
            "small"
        }
    }
}

impl<'a> fmt::Display for Point<'a> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "({})", self.x)
    }
}

fn sum_even<T: Into<Vec<u8>>>(items: T, skip: Option<u8>) -> u32 {
    let mut total = 0;
    'outer: for v in items.into().iter() {
        match skip {
            Some(s) if s == *v => continue 'outer,
            Some(_) | None => {}
        }
        let r = match v % 2 {
            0 => *v as u32,
            _ => 0,
        };
        total += r;
        let f = || total > 10;
        if f() || r == 0 { break; }
    }
    loop {
        if total > 0 { break 'outer_never_used_label_ok; }
    }
    total
}
