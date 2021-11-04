

async function main() {
  const U3RFAddr = ""

  const [deployer] = await ethers.getSigners();

  const Contract = await ethers.getContractFactory("uniV3Relayed");
  const U3RFun = await Contract.attach(U3RFAddr).connect(deployer);
  
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
  