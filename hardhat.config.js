require("@nomicfoundation/hardhat-toolbox");
const { task } = require("hardhat/config");
const fs = require("fs");
const path = require("path");


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
      version: "0.8.30",
      settings: {
          optimizer: { enabled: true, runs: 10000 },
          viaIR: true,
      },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },    
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      initialBaseFeePerGas: 0,  // ⬅️ disables base fee (post–London fork)
      gasPrice: 1
    }
  }   
};


task("export-abi", "Exports ABIs to ./abi")
  .setAction(async (_, hre) => {
    const outputDir = path.join(__dirname, "abi");

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    // Collect all fully qualified contract names
    const allNames = await hre.artifacts.getAllFullyQualifiedNames();
    console.log(`Found ${allNames.length} contracts to export...`);

    for (const name of allNames) {
      const artifact = await hre.artifacts.readArtifact(name);
      const contractName = name.split(":").pop();
      const outputPath = path.join(outputDir, `${contractName}.json`);

      fs.writeFileSync(outputPath, JSON.stringify(artifact.abi, null, 2));
      console.log(`✅ Exported ABI for ${contractName}`);
    }

    console.log(`🎉 All ABIs exported to: ${outputDir}`);
});


task("export-bytecode", "Exports creation and runtime bytecode for all contracts")
  .setAction(async (_, hre) => {
    const outputDir = path.join(__dirname, "build-artifacts");

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const allNames = await hre.artifacts.getAllFullyQualifiedNames();
    console.log(`Found ${allNames.length} compiled contracts.`);

    for (const name of allNames) {
      const artifact = await hre.artifacts.readArtifact(name);
      const contractName = name.split(":").pop();

      // Extract key parts
      const { bytecode, deployedBytecode, linkReferences } = artifact;

      const exportData = {
        contractName,
        sourceName: artifact.sourceName,
        bytecode,
        deployedBytecode,
        linkReferences,
      };

      const filePath = path.join(outputDir, `${contractName}.bytecode.json`);
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));

      console.log(`✅ Exported bytecode for ${contractName}`);
    }

    console.log(`🎉 All bytecode files exported to: ${outputDir}`);
  });