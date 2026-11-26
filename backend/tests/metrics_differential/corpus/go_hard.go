package hard

import "errors"

type Store struct {
	items []int
}

func (s *Store) Add(v int) error {
	if v < 0 {
		return errors.New("negative")
	}
	s.items = append(s.items, v)
	return nil
}

func (s Store) Sum() (total int) {
	for _, v := range s.items {
		total += v
	}
	return
}

func Worker(jobs <-chan int, done chan struct{}) int {
	count := 0
	for {
		select {
		case j, ok := <-jobs:
			if !ok {
				return count
			}
			count += j
		case <-done:
			return count
		default:
			if count > 100 && len(jobs) == 0 {
				return count
			}
		}
	}
}

func Apply(values []int, fn func(int) int) []int {
	out := make([]int, 0, len(values))
	square := func(n int) int { return n * n }
	for _, v := range values {
		switch {
		case v > 10:
			out = append(out, square(v))
		case v > 0:
			out = append(out, fn(v))
		}
	}
	return out
}
