fn classify(x: u32) u32 {
    return switch (x) {
        1 => 10,
        2 => 20,
        else => 0,
    };
}
