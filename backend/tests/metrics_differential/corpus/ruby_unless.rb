def check(value)
  unless value
    return :missing
  end
  value > 0 ? :positive : :other
end
