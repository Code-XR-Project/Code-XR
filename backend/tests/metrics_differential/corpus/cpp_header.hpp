#pragma once
#include <string>

namespace util {

class Text {
public:
    explicit Text(std::string value) : value_(std::move(value)) {}

    bool empty() const noexcept { return value_.empty(); }

    std::string trimmed() const {
        size_t first = 0;
        while (first < value_.size() && value_[first] == ' ') {
            ++first;
        }
        return value_.substr(first);
    }

private:
    std::string value_;
};

template <typename T>
T max_of(T a, T b) {
    return a < b ? b : a;
}

}  // namespace util
