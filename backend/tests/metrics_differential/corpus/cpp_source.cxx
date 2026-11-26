#include <vector>

struct Matrix {
    std::vector<double> data;
    int rows, cols;

    double at(int r, int c) const { return data[r * cols + c]; }
};

double trace(const Matrix& m) {
    double sum = 0;
    for (int i = 0; i < m.rows && i < m.cols; ++i)
        sum += m.at(i, i);
    return sum;
}
