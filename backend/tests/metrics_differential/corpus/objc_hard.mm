#import <Foundation/Foundation.h>

@interface Counter : NSObject
- (NSInteger)addValue:(NSInteger)value times:(NSInteger)times;
@end

@implementation Counter

- (NSInteger)addValue:(NSInteger)value times:(NSInteger)times {
    NSInteger total = 0;
    for (NSInteger i = 0; i < times; i++) {
        if (value > 0 && i % 2 == 0) {
            total += value;
        }
    }
    return total;
}

+ (instancetype)shared {
    static Counter *instance = nil;
    if (!instance) {
        instance = [[Counter alloc] init];
    }
    return instance;
}

@end

int helper(int x) {
    auto twice = [](int v) { return v * 2; };
    return x > 0 ? twice(x) : 0;
}
