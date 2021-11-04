const { expect } = require("chai");
const { ethers, waffle } = require("hardhat");

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const WETH9 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RAI = '0x03ab458634910AaD20eF5f1C8ee96F1D6ac54919';

const GWEI = ethers.BigNumber.from(10).pow(18);

let U3R;
let owner;
let controller;
let user;
let frontrunner;
let provider;

before(async function () {
  provider = waffle.provider;
  [owner] = await ethers.getSigners();

  user = ethers.Wallet.createRandom().connect(provider);
  await owner.sendTransaction({to: user.address, value: GWEI.mul('100')});

  frontrunner = ethers.Wallet.createRandom().connect(provider);
  await owner.sendTransaction({to: frontrunner.address, value: GWEI.mul('100')});

  controller = ethers.Wallet.createRandom().connect(provider);

  const Fact = await ethers.getContractFactory("uniV3Relayed");
  U3R = await Fact.deploy(UNI_FACTORY, controller.address);

  const gasFactory = await ethers.getContractFactory("U3RGasTank");
  const gas_address = await U3R.gasTank();
  gasTank = gasFactory.attach(gas_address);

  console.log("deployer : "+owner.address);
  console.log("user : "+user.address);
  console.log("controller : "+controller.address);
  console.log("frontrunner : "+frontrunner.address);
  console.log("GasTank : "+gasTank.address);
  console.log("U3R : "+U3R.address);
});

describe.only("U3R: ETH -> exact 4000 DAI @ 0.3%", function () {

  let deadline;
  let amountOut;
  let curr_nonce;
  let sqrtPriceLim;
  let fees;
  let exactIn;
  let pool;
  let quoteInETH;
  let quoteWithSlippage;
  let sig;
  let full_payload;
  let maxGasFee;

  it("set payload+nonce", async function () { 
    deadline = Date.now()+60;
    amountOut = GWEI.mul(4000);
    curr_nonce = await U3R.nonces(user.address);
    sqrtPriceLim = 0;
    fees = 3000;
    exactIn = false;
    maxGasFee = 100;
    expect(curr_nonce).to.equal(0);
  })

  it("compute pool address", async function () {
    const key = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([ "address", "address", "uint24"], [DAI, WETH9, fees]));
    const keccak = ethers.utils.solidityKeccak256(["bytes", "address", "bytes", "bytes32"], ["0xff", UNI_FACTORY, key, POOL_INIT_CODE_HASH]);
    // keccak is 64 hex digit/nibbles == 32 bytes -> take rightmost 20 bytes=40 nibbles -> start at 64-40=24nibbles or 12 bytes
    pool = ethers.utils.hexDataSlice(keccak, 12);
    expect(pool).to.equals('0xc2e9f25be6257c210d7adf0d4cd6e3e881ba25f8');
  }),

  it("retrieve price from slot0", async function () { 
    const slot0abi = ["function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"];
    const IPool = new ethers.Contract(pool, slot0abi, provider);
    const slot0data = await IPool.slot0();
    const curr_tick = slot0data.tick;
    quoteInETH = ethers.BigNumber.from(((amountOut * (1.0001**curr_tick))).toString());
    quoteWithSlippage = quoteInETH.add(quoteInETH.mul(5).div(100));    
    console.log("quote: 4000 DAI <=> "+(quoteInETH/10**18)+" ETH");
    expect(quoteInETH).to.be.not.null; // check the console.log -- todo: compare with price api
  }),

  it("payload packing and signing", async function () { 
    // -- payload abi encoding --
    const swapParams = ethers.utils.defaultAbiCoder.encode(
        ["tuple(uint256, uint256,            uint256,  uint256,     uint256, address,  uint160,        bool)"],
        [[     amountOut, quoteWithSlippage, deadline, curr_nonce,  maxGasFee, pool,    sqrtPriceLim,  exactIn]]);
    const callbackData = ethers.utils.defaultAbiCoder.encode(
        ["tuple(address, address, address,      uint24)"],
        [[       WETH9,      DAI, user.address,   fees]]);
    full_payload = ethers.utils.defaultAbiCoder.encode(["bytes", "bytes"], [swapParams, callbackData]);

    // -- hash and sign --
    const messageHashBytes = ethers.utils.keccak256(full_payload);
    const flatSig = await controller.signMessage(ethers.utils.arrayify(messageHashBytes));
    sig = ethers.utils.splitSignature(flatSig);
  }),

  it("send ETH to gasTank", async function () { 
    await gasTank.connect(user).deposit({value: quoteWithSlippage});
    expect(await gasTank.balanceOf(user.address)).to.equals(quoteWithSlippage);
  }),

  it("send bribe to gasTank", async function () { 
    const bribe = ethers.BigNumber.from((maxGasFee + 1) * 189000);
    await gasTank.connect(user).deposit({value: bribe});
    expect(await gasTank.balanceOf(user.address)).to.equals(quoteWithSlippage.add(bribe));
  }),

  it("value returned by static call to swap function", async function () { 
    const eth_swapped = await U3R.connect(frontrunner).callStatic.relayedSwap(sig.v, sig.r, sig.s, full_payload);
    expect(eth_swapped).to.be.closeTo(quoteInETH, quoteWithSlippage.sub(quoteInETH)); // = quote was correct, with margin of error = slippage
  }),

  it("Actual swap->new balances ?", async function () { 
    const eth_balance_before = await provider.getBalance(user.address);
    const frontrunner_before = await provider.getBalance(frontrunner.address);
    
    const tx = await U3R.connect(frontrunner).relayedSwap(sig.v, sig.r, sig.s, full_payload);
    await tx.wait();

    const frontrunner_after = await provider.getBalance(frontrunner.address);
    const eth_balance_after = await provider.getBalance(user.address);

    const DAI_contract = new ethers.Contract(DAI, ["function balanceOf(address) external view returns (uint256)"], user);
    const DAI_balance = await DAI_contract.balanceOf(user.address);
    console.log("DAI balance: "+DAI_balance/10**18);
    
    expect(DAI_balance).to.be.equals((4000*10**18).toLocaleString('fullwide', {useGrouping:false})); // = quote was correct, with margin of error = slippage
    expect(eth_balance_after).equals(eth_balance_before); // = no gas spend
    //expect(frontrunner_after).greaterThan(frontrunner_before); //bribe ?
    console.log("bribe received: "+(frontrunner_after.sub(frontrunner_before)).toString());
  })
});


describe("U3R: exact 4000 DAI -> RAI @ 0.05%", function () {

  let deadline;
  let amountIn;
  let curr_nonce;
  let sqrtPriceLim;
  let fees;
  let exactIn;
  let pool;
  let quoteInDAI;
  let minOutInRAI;
  let sig;
  let full_payload;
  let maxGasFee;

  it("set payload+nonce", async function () { 
    fees = 500;
    deadline = Date.now()+60;
    amountIn = GWEI.mul('4000');
    curr_nonce = await U3R.nonces(user.address);
    exactIn = true;
    sqrtPriceLim = 0;
    maxGasFee = 100;
    expect(curr_nonce).to.equal('1');
  }),

  it("compute pool address", async function () {
    // -- compute pool address --
    const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
    const key = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([ "address", "address", "uint24"], [RAI, DAI, fees]));
    const keccak = ethers.utils.solidityKeccak256(["bytes", "address", "bytes", "bytes32"], ["0xff", UNI_FACTORY, key, POOL_INIT_CODE_HASH]);
    // keccak is 64 hex digit/nibbles == 32 bytes -> take rightmost 20 bytes=40 nibbles -> start at 64-40=24nibbles or 12 bytes
    pool = ethers.utils.hexDataSlice(keccak, 12);
    expect(pool).equals('0xcb0c5d9d92f4f2f80cce7aa271a1e148c226e19d');
  }),

  it("retrieve price from slot0", async function () { 
    // -- retrieve price from slot0 (based on 1.0001^current tick) --
    const slot0abi = ["function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"];
    const IPool = new ethers.Contract(pool, slot0abi, provider);
    const slot0data = await IPool.slot0();
    const curr_tick = slot0data.tick;
    quoteInDAI = ethers.BigNumber.from( (amountIn/1.0001**curr_tick).toLocaleString('fullwide', {useGrouping:false}) ); // P=token0/token1 -> RAI per DAI
    console.log("quote: 4000 DAI <=> "+(quoteInDAI/10**18)+" CRV");
    minOutInRAI = quoteInDAI.sub(quoteInDAI.mul(5).div(100));
    expect(quoteInDAI).to.be.not.null; // check the console.log -- todo: compare with price api
  }),

  it("payload packing and signing", async function () { 
    const swapParams = ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256, uint256,      uint256,    uint256, uint256, address,          uint160, bool)"],
      [[     amountIn, minOutInRAI, deadline, curr_nonce,  maxGasFee,  pool,    sqrtPriceLim,  exactIn]]);
    const callbackData = ethers.utils.defaultAbiCoder.encode(
      ["tuple(address, address, address, uint24)"],
      [[DAI,       RAI,      user.address,      fees]]);
    full_payload = ethers.utils.defaultAbiCoder.encode(["bytes", "bytes"], [swapParams, callbackData]);

    // -- hash and sign --
    const messageHashBytes = ethers.utils.keccak256(full_payload);
    const flatSig = await controller.signMessage(ethers.utils.arrayify(messageHashBytes));
    sig = ethers.utils.splitSignature(flatSig);
  }),

  it("DAI approval", async function () { 
    const approve_abi = ["function approve(address spender, uint256 amount) external returns (bool)",
                          "function allowance(address, address) external view returns (uint256)"];
    const dai_contract = new ethers.Contract(DAI, approve_abi, user);
    const apr_tx = await dai_contract.approve(U3R.address, amountIn);
    await apr_tx.wait();
    const new_allowance = await dai_contract.allowance(user.address, U3R.address);
    expect(new_allowance).equals(amountIn);
  }),

  it("send bribe to gasTank", async function () {
    const bal_before = await gasTank.balanceOf(user.address);
    const bribe = ethers.BigNumber.from((maxGasFee + 1) * 189000);
    await gasTank.connect(user).deposit({value: bribe});
    expect(await gasTank.balanceOf(user.address)).to.equals(bal_before.add(bribe));
  }),

  it("value returned by static call to swap function", async function () { 
    const RAI_received = await U3R.connect(owner).callStatic.relayedSwap(sig.v, sig.r, sig.s, full_payload);
    expect(RAI_received).to.be.closeTo(quoteInDAI, quoteInDAI.sub(minOutInRAI)); // correct quote
  }),

  it("Actual swap->new balances ?", async function () { 
    const eth_balance_before = await provider.getBalance(user.address);
    const tx = await U3R.connect(owner).relayedSwap(sig.v, sig.r, sig.s, full_payload);
    await tx.wait();
    const eth_balance_after = await provider.getBalance(user.address);

    const RAI_contract = new ethers.Contract(RAI, ["function balanceOf(address) external view returns (uint256)"], user);
    const RAI_balance = await RAI_contract.balanceOf(user.address);
    console.log("RAI balance: "+RAI_balance/10**18);


    expect(RAI_balance).to.be.closeTo(quoteInDAI, quoteInDAI.sub(minOutInRAI)); // correct swap
    expect(eth_balance_after).to.be.equals(eth_balance_before); // 0 gas spend
  })
})
