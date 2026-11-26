program main
  implicit none
  integer :: i, total
  total = 0
  do i = 1, 10
    if (mod(i, 2) == 0 .or. i == 5) total = total + i
  end do
  print *, total
end program main
