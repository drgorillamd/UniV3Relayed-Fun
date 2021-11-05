//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "hardhat/console.sol";

import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev swapRouter -> exactOutput - can be changed for multi or exact input 

contract U3RGasTank is Ownable {

    event GasTankUsed(address payer, uint256 amount, address dest);

    mapping(address => uint256) public balanceOf;

    constructor() {}

    function deposit(address user) external payable {
        balanceOf[user] += msg.value;
    }

    function depositFrom(address _from) external payable {
        balanceOf[_from] += msg.value;
    }

    function withdraw() external {
        require(balanceOf[msg.sender] > 0, "balance 0");
        uint256 to_send = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: to_send}(new bytes(0));
        require(success, 'GT:withdraw error');
    }
    
    function use(address payer, uint256 amount) external onlyOwner {
        require(balanceOf[payer] >= amount, "GT:empty");
        balanceOf[payer]-=amount;

        (bool success, ) = owner().call{value: amount}(new bytes(0));
        require(success, 'GT:use error');

        emit GasTankUsed(payer, amount, msg.sender);
    }

}