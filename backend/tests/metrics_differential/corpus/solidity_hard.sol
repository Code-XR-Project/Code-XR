// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Vault {
    mapping(address => uint256) private balances;
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0 && msg.sender != address(0), "bad");
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        if (amount > balances[msg.sender]) {
            revert("insufficient");
        }
        for (uint256 i = 0; i < 1; i++) {
            balances[msg.sender] -= amount;
        }
        payable(msg.sender).transfer(amount);
    }

    receive() external payable {}
}
