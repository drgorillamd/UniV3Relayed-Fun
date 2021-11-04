-- UNAUDITED and probably optimizable in so many ways - 
-------------------------------------------------------

## Uniswap V3 gas-sponsored swaps, the fun version:

 alternative approach: bribing front-running actor to swap while extracting MEV (EIP1559 only).
 - Swap recipient needs to have some ETH in the gasTank contract
 - Swap recipient ask for a swap and the controller craft the payload, including a 'reasonnable' maxFeePerGas (Payload_MFPG hereafter)
 - Controller signs the payload and send it with an abnormaly low maxFeePerGas (for instance, a correct baseFee but 0 wei priorityFee).
 - Any actor simulating this tx would end up with EV+ if a correct maxFeePerGas is used (ideally, maxFeePerGas==Payload_MFPG,
   if the controller has a correct estimation), since the (Payload_MFPG+1)*gas_used is reimbursed at the end of the swap function.

 Risk: overpaying (if the gas price dump a few block after and no-one frontrun the tx in the meantime), capped at (Payload_MFPG+1)*gas_used
