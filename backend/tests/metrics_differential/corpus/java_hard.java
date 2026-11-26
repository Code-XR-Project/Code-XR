import java.util.*;
import java.util.function.Function;

public class Hard<T extends Comparable<T>> {
    private final List<T> items = new ArrayList<>();

    public Hard() {
    }

    public <R> List<R> map(Function<T, R> fn) {
        List<R> out = new ArrayList<>();
        items.forEach(item -> {
            if (item != null) {
                out.add(fn.apply(item));
            }
        });
        return out;
    }

    public String label(int code) {
        return switch (code) {
            case 1, 2 -> "low";
            case 3 -> code > 2 ? "mid" : "odd";
            default -> "high";
        };
    }

    public Runnable task() {
        return new Runnable() {
            @Override
            public void run() {
                for (T item : items) {
                    if (item == null || items.isEmpty()) {
                        continue;
                    }
                }
            }
        };
    }

    static int search(int[] values, int target) {
        int lo = 0, hi = values.length - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (values[mid] < target) lo = mid + 1;
            else if (values[mid] > target) hi = mid - 1;
            else return mid;
        }
        do {
            lo--;
        } while (lo > 0 && values[lo] == target);
        try {
            return Integer.parseInt("x");
        } catch (NumberFormatException e) {
            return -1;
        } finally {
            lo = 0;
        }
    }
}
