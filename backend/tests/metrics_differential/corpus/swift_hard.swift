import Foundation

struct Account {
    private(set) var balance: Int = 0

    init(start: Int) {
        balance = start
    }

    mutating func withdraw(_ amount: Int) -> Bool {
        guard amount > 0, amount <= balance else {
            return false
        }
        balance -= amount
        return true
    }

    func describe(owner: String?) -> String {
        let name = owner ?? "unknown"
        switch balance {
        case ..<0:
            return "\(name) is overdrawn"
        case 0:
            return "\(name) is empty"
        default:
            return balance > 1000 ? "\(name) is rich" : name
        }
    }
}

func process(_ values: [Int], transform: (Int) -> Int) -> [Int] {
    var out: [Int] = []
    for value in values where value > 0 {
        if let doubled = Optional(transform(value)), doubled < 100 {
            out.append(doubled)
        }
    }
    return out.map { $0 + 1 }
}
