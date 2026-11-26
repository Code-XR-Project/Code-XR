#ifndef HARD_H
#define HARD_H

#include <stddef.h>

typedef struct {
    int width;
    int height;
} size2d;

static inline int clamp(int value, int low, int high) {
    if (value < low) {
        return low;
    }
    return value > high ? high : value;
}

static inline size_t count_set(unsigned long bits) {
    size_t count = 0;
    while (bits) {
        count += bits & 1u;
        bits >>= 1;
    }
    return count;
}

int area(size2d s);

#endif
