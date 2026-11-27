# Blocks, modifiers and case/when.
class Inventory
  def initialize(items = [])
    @items = items
  end

  def total
    @items.sum { |item| item[:price] || 0 }
  end

  def find(name)
    return nil if name.nil? || name.empty?
    @items.each do |item|
      return item if item[:name] == name
    end
    nil
  end

  def label(count)
    case count
    when 0 then 'none'
    when 1..5 then 'few'
    else 'many'
    end
  end

  def restock(amount)
    begin
      raise ArgumentError, 'bad' unless amount.positive?
      amount.times { @items << {} }
    rescue ArgumentError => e
      warn e.message
    ensure
      @items.compact!
    end
  end

  def self.build(*names)
    names.map { |n| { name: n } }.then { |items| new(items) }
  end
end
