#include <map>
#include <string>

class Registry {
public:
    int lookup(const std::string& key) const;
    void add(const std::string& key, int value);
private:
    std::map<std::string, int> entries_;
};

int Registry::lookup(const std::string& key) const {
    auto it = entries_.find(key);
    if (it == entries_.end()) {
        return -1;
    }
    return it->second;
}

void Registry::add(const std::string& key, int value) {
    if (key.empty() || value < 0) return;
    for (int i = 0; i < 3; ++i) {
        try {
            entries_[key] = value;
            break;
        } catch (...) {
            continue;
        }
    }
}
