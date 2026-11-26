module shapes
  implicit none
  type :: circle
    real :: r
  contains
    procedure :: area
  end type circle
contains
  real function area(self)
    class(circle), intent(in) :: self
    if (self%r > 0.0) then
      area = 3.14159 * self%r ** 2
    else
      area = 0.0
    end if
  end function area
end module shapes
