class Account {
  private int balance;

  public int Balance {
    get { return balance > 0 ? balance : 0; }
  }

  public int Withdraw(int amount) {
    if (amount > balance) {
      return 0;
    }
    balance -= amount;
    return amount;
  }
}
