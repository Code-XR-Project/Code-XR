sub sign {
  my ($value, $zero) = @_;
  return $value > 0 ? 1 : $zero;
}
