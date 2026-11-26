#include <vector>
#define SQUARE(x) ((x) * (x))

namespace geo {

template <typename T>
struct Point {
    T x, y;
    Point(T x, T y) : x(x), y(y) {}
    Point operator+(const Point& other) const { return Point(x + other.x, y + other.y); }
    bool operator==(const Point& other) const { return x == other.x && y == other.y; }
};

class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
};

class Circle : public Shape {
public:
    explicit Circle(double r) : r_(r) {}
    double area() const override {
        return r_ > 0 ? 3.14159 * r_ * r_ : 0.0;
    }
private:
    double r_;
};

int count_positive(const std::vector<int>& values) {
    int count = 0;
    for (auto v : values) {
        if (v > 0) {
            ++count;
        } else if (v == 0) {
            continue;
        }
    }
    auto twice = [&](int n) { return n > 0 ? n * 2 : 0; };
    return twice(count);
}

}  // namespace geo

int geo_main(int argc, char** argv) {
    switch (argc) {
        case 0:
            return 1;
        case 1:
            if (argv && argv[0]) {
                return 2;
            }
            break;
        default:
            break;
    }
    return 0;
}
