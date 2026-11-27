using System;
using System.Linq;

namespace Hard
{
    public class Account
    {
        private decimal balance;

        public Account(decimal start) => balance = start;

        public decimal Balance
        {
            get { return balance; }
            private set
            {
                if (value < 0) { throw new ArgumentException("negative"); }
                balance = value;
            }
        }

        public string Name { get; set; } = "";

        public bool IsRich => balance > 1000m && Name != null;

        public decimal Withdraw(decimal amount)
        {
            if (amount <= 0 || amount > balance)
            {
                return 0;
            }
            Balance -= amount;
            return amount;
        }

        public int CountLarge(int[] values)
        {
            var count = 0;
            foreach (var v in values.Where(x => x > 10))
            {
                count += v > 100 ? 2 : 1;
            }
            return count;
        }

        public string Describe(object o) => o switch
        {
            int i when i > 0 => "positive",
            string s => s ?? "empty",
            _ => "other",
        };
    }
}
