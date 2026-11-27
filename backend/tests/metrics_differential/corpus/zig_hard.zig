const std = @import("std");

pub fn parse(text: []const u8) !u32 {
    var total: u32 = 0;
    for (text) |c| {
        if (c >= '0' and c <= '9') {
            total = total * 10 + (c - '0');
        } else {
            return error.Invalid;
        }
    }
    return total;
}

fn kind(value: i32) []const u8 {
    return switch (value) {
        0 => "zero",
        1...9 => "small",
        else => "big",
    };
}

pub fn first(items: []const ?u32) u32 {
    var i: usize = 0;
    while (i < items.len) : (i += 1) {
        const item = items[i] orelse continue;
        return item;
    }
    return 0;
}
