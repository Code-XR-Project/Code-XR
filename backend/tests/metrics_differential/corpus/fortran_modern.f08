module stats
  implicit none
contains
  pure function mean(values) result(m)
    real, intent(in) :: values(:)
    real :: m
    if (size(values) == 0) then
      m = 0.0
      return
    end if
    m = sum(values) / size(values)
  end function mean

  subroutine classify(x, label)
    integer, intent(in) :: x
    character(len=*), intent(out) :: label
    select case (x)
    case (:-1)
      label = 'negative'
    case (0)
      label = 'zero'
    case default
      label = 'positive'
    end select
  end subroutine classify
end module stats
