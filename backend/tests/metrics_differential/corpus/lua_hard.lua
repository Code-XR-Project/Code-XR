local Stack = {}
Stack.__index = Stack

function Stack.new()
  return setmetatable({ items = {} }, Stack)
end

function Stack:push(value)
  if value == nil then
    error("nil value")
  end
  table.insert(self.items, value)
end

function Stack:pop()
  local n = #self.items
  if n == 0 then
    return nil
  elseif n == 1 then
    return table.remove(self.items)
  end
  return table.remove(self.items, n)
end

local function sum(list)
  local total = 0
  for _, v in ipairs(list) do
    total = total + (v or 0)
  end
  local i = 0
  repeat
    i = i + 1
  until i >= #list or total > 100
  return total
end

local square = function(x) return x * x end

return { Stack = Stack, sum = sum, square = square }
