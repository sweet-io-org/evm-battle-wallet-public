const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DOMAIN_VERSION = "1";

const RESERVE_TYPES = {
  RESERVE: [
    { name: "gameId", type: "uint64" },
    { name: "amount", type: "uint256" },
    { name: "player1", type: "address" },
    { name: "player2", type: "address" },
    { name: "isToken", type: "bool" },
    { name: "noncePlayer1", type: "uint64" },
    { name: "noncePlayer2", type: "uint64" },
    { name: "feeWallet", type: "address" },
    { name: "feeBasisPoints", type: "uint16" },
    { name: "factory", type: "address" },
  ],
};

const CANCEL_TYPES = {
  CANCEL: [
    { name: "gameId", type: "uint64" },
    { name: "factory", type: "address" },
  ],
};

const RELEASE_EXPIRED_TYPES = {
  RELEASE_EXPIRED: [
    { name: "wallet", type: "address" },
    { name: "factory", type: "address" },
  ],
};

const SETTLE_TYPES = {
  SETTLE: [
    { name: "gameId", type: "uint64" },
    { name: "winner", type: "address" },
    { name: "loser", type: "address" },
    { name: "factory", type: "address" },
  ],
};

const UPGRADE_TYPES = {
  UPGRADE: [
    { name: "wallet", type: "address" },
    { name: "newImplementation", type: "address" },
    { name: "dataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

const EMPTY_SIG = "0x";

function buildDomain(name, verifyingContract, chainId) {
  return {
    name,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

function buildFactoryDomain(factory, chainId) {
  return buildDomain("BattleWalletFactory", factory.target ?? factory, chainId);
}

function buildWalletDomain(walletAddress, chainId) {
  return buildDomain("BattleWallet", walletAddress, chainId);
}

function buildProxyDomain(proxyAddress, chainId) {
  return buildDomain("BattleWalletProxy", proxyAddress, chainId);
}

async function signReserve(signer, domain, request) {
  return signer.signTypedData(domain, RESERVE_TYPES, request);
}

async function generateGameId(gameNumber) {
  return BigInt(gameNumber);
}

function popRandomElement(arr) {
  if (arr.length === 0) {
    return undefined; 
  }
  const randomIndex = Math.floor(Math.random() * arr.length);
  const removedElement = arr.splice(randomIndex, 1)[0];
  return removedElement;
}

function normalizeApproval(approvals, playerAddress) {
  const key = ethers.getAddress(playerAddress);
  return approvals?.[key] ?? EMPTY_SIG;
}

function relayReserveTx(factory, caller, request, signature, approvals = {}) {
  const approvalOne = normalizeApproval(approvals, request.player1);
  const approvalTwo = normalizeApproval(approvals, request.player2);
  return factory
    .connect(caller)
    .relayReserve(request, signature, approvalOne, approvalTwo);
}

function relaySettleTx(factory, caller, settlement, signature) {
  return factory.connect(caller).relaySettle(settlement, signature);
}

function relayCancelTx(factory, caller, walletOne, walletTwo, gameId, signature) {
  return factory.connect(caller).relayCancel(walletOne, walletTwo, gameId, signature);
}

function relayReleaseExpiredTx(factory, caller, walletAddress, signature) {
  return factory.connect(caller).relayReleaseExpired(walletAddress, signature);
}

function randomInt(min, max) {
  min = Math.ceil(min);   // round up to ensure min is included
  max = Math.floor(max);  // round down to ensure max is included
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getCurrentNonce(nonceMap, address) {
  const key = ethers.getAddress(address);
  return nonceMap.get(key) ?? 0n;
}

function bumpNonce(nonceMap, address) {
  const key = ethers.getAddress(address);
  const current = nonceMap.get(key) ?? 0n;
  nonceMap.set(key, current + 1n);
}

function assignNonces(nonceMap, player1, player2) {
  return {
    noncePlayer1: getCurrentNonce(nonceMap, player1),
    noncePlayer2: getCurrentNonce(nonceMap, player2),
  };
}

function bumpNoncesAfterReserve(nonceMap, player1, player2) {
  bumpNonce(nonceMap, player1);
  bumpNonce(nonceMap, player2);
}

function withFactory(contractRef, params) {
  if ("player1" in params && "player2" in params) {
    return {
      factory: contractRef.target,
      feeWallet: ethers.ZeroAddress,
      feeBasisPoints: 0,
      ...params,
    };
  }
  return {
    factory: contractRef.target,
    ...params,
  };
}

async function signCancel(signer, domain, gameId, factoryOverride) {
  return signer.signTypedData(domain, CANCEL_TYPES, {
    gameId,
    factory: factoryOverride ?? domain.verifyingContract,
  });
}

async function signReleaseExpired(signer, domain, walletAddress, factoryOverride) {
  return signer.signTypedData(domain, RELEASE_EXPIRED_TYPES, {
    wallet: walletAddress,
    factory: factoryOverride ?? domain.verifyingContract,
  });
}

async function signSettlement(signer, domain, request) {
  return signer.signTypedData(domain, SETTLE_TYPES, request);
}

async function signUpgrade(signer, domain, walletAddress, newImplementation, data, nonce) {
  return signer.signTypedData(domain, UPGRADE_TYPES, {
    wallet: walletAddress,
    newImplementation,
    dataHash: ethers.keccak256(data),
    nonce,
  });
}

describe("BattleWallet (EVM)", () => {
  async function deployFixture() {
    const [owner, factoryOwner, adminSigner, user, opponent, feeWallet, stranger] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const Wallet = await ethers.getContractFactory("BattleWallet");
    const walletImplementation = await Wallet.deploy();
    await walletImplementation.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const tokenSupply = ethers.parseEther("1000000");
    const token = await Token.deploy("Test Token", "TEST", 18, tokenSupply, owner.address);
    await token.waitForDeployment();

    const Factory = await ethers.getContractFactory("BattleWalletFactory");
    const factory = await Factory.deploy(
      walletImplementation.target,
      factoryOwner.address,
      adminSigner.address,
      token.target,
    );
    await factory.waitForDeployment();

    await factory.connect(factoryOwner).setReservationTtl(60);

    const walletAddress = await factory.predictBattleWalletAddress(owner.address);
    await factory.deployBattleWallet(owner.address);
    const wallet = await ethers.getContractAt("BattleWallet", walletAddress);

    const opponentWalletAddress = await factory.predictBattleWalletAddress(opponent.address);
    await factory.deployBattleWallet(opponent.address);
    const opponentWallet = await ethers.getContractAt("BattleWallet", opponentWalletAddress);

    await owner.sendTransaction({ to: wallet.target, value: ethers.parseEther("100") });
    await opponent.sendTransaction({ to: opponentWalletAddress, value: ethers.parseEther("100") });
    return {
      chainId,
      wallet,
      walletAddress,
      factory,
      token,
      owner,
      factoryOwner,
      adminSigner,
      user,
      opponent,
      opponentWallet,
      opponentWalletAddress,
      feeWallet,
      stranger,
    };
  }

  async function factoryFixture() {
    const [owner, factoryOwner, adminSigner] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const Wallet = await ethers.getContractFactory("BattleWallet");
    const walletImplementation = await Wallet.deploy();
    await walletImplementation.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const tokenSupply = ethers.parseEther("1000000");
    const token = await Token.deploy("Test Token", "TEST", 18, tokenSupply, owner.address);
    await token.waitForDeployment();

    const Factory = await ethers.getContractFactory("BattleWalletFactory");
    const factory = await Factory.deploy(
      walletImplementation.target,
      factoryOwner.address,
      adminSigner.address,
      token.target,
    );
    await factory.waitForDeployment();

    return { factory, walletImplementation, owner, factoryOwner, chainId, token };
  }

  describe("factory", () => {
    it("predicts deterministic address for wallet deployment", async () => {
      const { factory, walletImplementation, owner } = await loadFixture(factoryFixture);
      const predicted = await factory.predictBattleWalletAddress(owner.address);

      await expect(factory.deployBattleWallet(owner.address))
        .to.emit(factory, "BattleWalletDeployed")
        .withArgs(owner.address, predicted, walletImplementation.target);

      const code = await ethers.provider.getCode(predicted);
      expect(code).to.not.equal("0x");
    });

    it("double deploment of a battle wallet will revert", async () => {
      const { factory, walletImplementation, owner } = await loadFixture(factoryFixture);
      const predicted = await factory.predictBattleWalletAddress(owner.address);

      await expect(factory.deployBattleWallet(owner.address))
        .to.emit(factory, "BattleWalletDeployed")
        .withArgs(owner.address, predicted, walletImplementation.target);

      await expect(factory.deployBattleWallet(owner.address)).to.be.reverted;

      const code = await ethers.provider.getCode(predicted);
      expect(code).to.not.equal("0x");
    });

    it("initializes the factory with a shared token", async () => {
      const { factory, owner, token } = await loadFixture(factoryFixture);
      const predicted = await factory.predictBattleWalletAddress(owner.address);
      await factory.deployBattleWallet(owner.address);
      const wallet = await ethers.getContractAt("BattleWallet", predicted);

      expect(await factory.token()).to.equal(token.target);
      expect(await wallet.token()).to.equal(token.target);
      expect(await wallet.tokenSet()).to.equal(true);
    });

    it("allows deployment even if the token address is zero", async () => {
      const [owner, factoryOwner, adminSigner] = await ethers.getSigners();
      const Wallet = await ethers.getContractFactory("BattleWallet");
      const implementation = await Wallet.deploy();
      await implementation.waitForDeployment();

      const Factory = await ethers.getContractFactory("BattleWalletFactory");
      const factory = await Factory.deploy(
        implementation.target,
        factoryOwner.address,
        adminSigner.address,
        ethers.ZeroAddress,
      );
      await factory.waitForDeployment();
      // try and deploy a battle wallet, make sure that works as well
      const predicted = await factory.predictBattleWalletAddress(owner.address);
      await factory.deployBattleWallet(owner.address);
      const wallet = await ethers.getContractAt("BattleWallet", predicted);
      expect(await wallet.tokenSet()).to.equal(false);
    });

    it("updates the factory owner through the two-step transfer", async () => {
      const { factory, factoryOwner, owner, adminSigner } = await loadFixture(factoryFixture);

      await expect(factory.connect(factoryOwner).transferOwnership(owner.address))
        .to.emit(factory, "OwnershipTransferStarted")
        .withArgs(factoryOwner.address, owner.address);

      await expect(factory.connect(owner).setApprover(owner.address))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);

      await expect(factory.connect(owner).acceptOwnership())
        .to.emit(factory, "OwnershipTransferred")
        .withArgs(factoryOwner.address, owner.address);

      expect(await factory.owner()).to.equal(owner.address);

      await expect(factory.connect(factoryOwner).setApprover(owner.address))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(factoryOwner.address);

      await expect(factory.connect(owner).setApprover(owner.address))
        .to.emit(factory, "ApproverUpdated")
        .withArgs(owner.address);
    });

      
  });

  describe("nonce tracking", () => {
    it("returns the current nonce value", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      expect(await wallet.getCurrentNonce()).to.equal(0n);

      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(101n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, signature);

      expect(await wallet.getCurrentNonce()).to.equal(1n);
    });
  });

  describe("ether reservations", () => {
    it("reserves funds and tracks totals", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, opponentWalletAddress, stranger } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(1n),
        amount: ethers.parseEther("2.5"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await expect(relayReserveTx(factory, stranger, request, signature))
        .to.emit(wallet, "Reserved")
        .withArgs(request.gameId, opponentWalletAddress, request.amount, false);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      const totals = await wallet.getTotalReserved();
      expect(totals[0]).to.equal(request.amount);
      expect(totals[1]).to.equal(0n);

      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

    it("rejects duplicate game ids", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(2n),
        amount: ethers.parseEther("3"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, signature);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const dupeRequest = withFactory(factory, {
        gameId: request.gameId,
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });

      const signature2 = await signReserve(adminSigner, factoryDomain, dupeRequest);
      await expect(relayReserveTx(factory, owner, dupeRequest, signature2)).to.be.revertedWithCustomError(
        wallet,
        "GameExists"
      );
    });

    it("rejects reused nonces", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(30n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, sig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      await expect(relayReserveTx(factory, owner, request, sig)).to.be.revertedWithCustomError(
        wallet,
        "InvalidNonce"
      );
    });

    it("rejects reserve signatures from other factories", async () => {
      const { chainId, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(32n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const bogusFactory = ethers.Wallet.createRandom().address;
      const wrongFactoryRequest = { ...request, factory: bogusFactory };
      const wrongDomain = buildFactoryDomain(bogusFactory, chainId);
      const signature = await signReserve(adminSigner, wrongDomain, wrongFactoryRequest);
      await expect(relayReserveTx(factory, owner, wrongFactoryRequest, signature)).to.be.revertedWithCustomError(
        factory,
        "InvalidSignature"
      );
    });

    it("rejects out-of-order nonces", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const request = withFactory(factory, {
        gameId: await generateGameId(31n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        noncePlayer1: 1n,
        noncePlayer2: 0n,
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await expect(relayReserveTx(factory, owner, request, sig)).to.be.revertedWithCustomError(
        wallet,
        "InvalidNonce"
      );
    });

    it("reverts when reserving more than available", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(3n),
        amount: ethers.parseEther("1000"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await expect(relayReserveTx(factory, owner, request, signature)).to.be.revertedWithCustomError(wallet, "InsufficientFunds");
    });

    it("rejects reservations with excessive fee basis points", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(305n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        feeBasisPoints: 2501,
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await expect(relayReserveTx(factory, owner, request, signature)).to.be.revertedWithCustomError(
        wallet,
        "InvalidFeeBasisPoints"
      );
    });

    it("requires a fee wallet when fee basis points are set", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(306n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        feeBasisPoints: 500,
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const signature = await signReserve(adminSigner, factoryDomain, request);
      await expect(relayReserveTx(factory, owner, request, signature)).to.be.revertedWithCustomError(
        wallet,
        "ZeroAddress"
      );
    });

    it("settles when the wallet loses and pays winner and fee", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        owner,
        adminSigner,
        opponentWalletAddress,
        feeWallet,
        stranger,
      } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(4n),
        amount: ethers.parseEther("10"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        feeWallet: feeWallet.address,
        feeBasisPoints: 1000,
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: walletAddress,
      });
      const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);

      const beforeOpponent = await ethers.provider.getBalance(opponentWalletAddress);
      const beforeFee = await ethers.provider.getBalance(feeWallet.address);

      // event ReservationSettled(uint128 indexed gameId, address indexed winner, address indexed loser, uint256 amount, bool isToken);
      await expect(relaySettleTx(factory, stranger, settlement, settleSig))
        .to.emit(wallet, "ReservationSettled")
        .withArgs(settlement.gameId, settlement.winner, settlement.loser, request.amount, false);

      const afterOpponent = await ethers.provider.getBalance(opponentWalletAddress);
      const afterFee = await ethers.provider.getBalance(feeWallet.address);

      expect(afterOpponent - beforeOpponent).to.equal(ethers.parseEther("9"));
      expect(afterFee - beforeFee).to.equal(ethers.parseEther("1"));

      const totals = await wallet.getTotalReserved();
      expect(totals[0]).to.equal(0n);
    });

    it("rejects settlement when addresses do not match reservation", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        adminSigner,
        owner,
        opponentWalletAddress,
        feeWallet,
      } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(5n),
        amount: ethers.parseEther("5"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      const wrongFactorySettlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: opponentWalletAddress,
      });
      const settleSigWrongFactory = await signSettlement(adminSigner, factoryDomain, wrongFactorySettlement);
      await expect(
        relaySettleTx(factory, owner, wrongFactorySettlement, settleSigWrongFactory)
      ).to.be.revertedWithCustomError(wallet, "AddressMismatch");

      const randomWallet = await ethers.Wallet.createRandom();
      const settlementExternalLoser = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: randomWallet.address,
      });
      const settleSigExternalLoser = await signSettlement(adminSigner, factoryDomain, settlementExternalLoser);
      await expect(
        relaySettleTx(factory, owner, settlementExternalLoser, settleSigExternalLoser)
      ).to.be.revertedWithCustomError(factory, "InvalidWallet");

      const settlementExternalWinner = withFactory(factory, {
        gameId: request.gameId,
        winner: randomWallet.address,
        loser: walletAddress,
      });
      const settleSigExternalWinner = await signSettlement(adminSigner, factoryDomain, settlementExternalWinner);
      await expect(
        relaySettleTx(factory, owner, settlementExternalWinner, settleSigExternalWinner)
      ).to.be.revertedWithCustomError(factory, "InvalidWallet");
    });

    it("rejects settlement signatures from other factories", async () => {
      const { chainId, walletAddress, factory, adminSigner, owner, opponentWalletAddress, feeWallet } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(5_000n),
        amount: ethers.parseEther("2"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const bogusFactory = ethers.Wallet.createRandom().address;
      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: walletAddress,
      });
      const wrongFactorySettlement = { ...settlement, factory: bogusFactory };
      const wrongDomain = buildFactoryDomain(bogusFactory, chainId);
      const settleSig = await signSettlement(adminSigner, wrongDomain, wrongFactorySettlement);
      await expect(relaySettleTx(factory, owner, wrongFactorySettlement, settleSig)).to.be.revertedWithCustomError(
        factory,
        "InvalidSignature"
      );
    });

    it("rejects settlement after expiry", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress, feeWallet } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(6n),
        amount: ethers.parseEther("5"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 1);

      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: walletAddress,
      });
      const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);
      await expect(relaySettleTx(factory, owner, settlement, settleSig)).to.be.revertedWithCustomError(
        wallet,
        "ReservationExpired"
      );
    });

    it("allows the owner to withdraw available ether", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, stranger, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(7n),
        amount: ethers.parseEther("10"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      // random person can't withdraw
      await expect(wallet.connect(stranger).withdraw(ethers.parseEther("1"))).to.be.revertedWithCustomError(
        wallet,
        "SenderNotAllowed"
      );

      // can't withdraw more than is unreserved
      await expect(wallet.connect(owner).withdraw(ethers.parseEther("91"))).to.be.revertedWithCustomError(
        wallet,
        "InsufficientFunds"
      );

      const before = await ethers.provider.getBalance(owner.address);
      const tx = await wallet.connect(owner).withdraw(ethers.parseEther("5"));
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after + gasUsed - before).to.equal(ethers.parseEther("5"));
    });

    it("cancels a reservation with a valid signature", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(8n),
        amount: ethers.parseEther("3"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      const cancelSig = await signCancel(adminSigner, factoryDomain, request.gameId);
      await expect(
        relayCancelTx(
          factory,
          owner,
          walletAddress,
          opponentWalletAddress,
          request.gameId,
          cancelSig
        )
      )
        .to.emit(wallet, "ReservationCancelled")
        .withArgs(request.gameId);
      const totals = await wallet.getTotalReserved();
      expect(totals[0]).to.equal(0n);

      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

    it("rejects cancellation signatures from other factories", async () => {
      const { chainId, walletAddress, factory, adminSigner, owner, opponentWalletAddress } = await loadFixture(
        deployFixture
      );
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(9n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const bogusFactory = ethers.Wallet.createRandom().address;
      const bogusDomain = buildFactoryDomain(bogusFactory, chainId);
      const cancelSig = await signCancel(adminSigner, bogusDomain, request.gameId, bogusFactory);
      await expect(
        relayCancelTx(factory, owner, walletAddress, opponentWalletAddress, request.gameId, cancelSig)
      ).to.be.revertedWithCustomError(factory, "InvalidSignature");
    });

    it("releases expired reservations and omits them from active list", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      for (let i = 0; i < 2; i++) {
        const request = withFactory(factory, {
          gameId: await generateGameId(BigInt(400 + i)),
          amount: ethers.parseEther("5"),
          player1: walletAddress,
          player2: opponentWalletAddress,
          isToken: false,
          ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        });
        const sig = await signReserve(adminSigner, factoryDomain, request);
        await relayReserveTx(factory, owner, request, sig);
        bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      }

      const totalsBefore = await wallet.getTotalReserved();
      expect(totalsBefore[0]).to.equal(ethers.parseEther("10"));

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 10);
      const releaseSig = await signReleaseExpired(adminSigner, factoryDomain, walletAddress);
      await relayReleaseExpiredTx(factory, owner, walletAddress, releaseSig);

      const totalsAfter = await wallet.getTotalReserved();
      expect(totalsAfter[0]).to.equal(0n);

      const active = await wallet.getAllGames();
      expect(active.length).to.equal(0);
    });

    it("rejects release relays without the approver signature", async () => {
      const { chainId, walletAddress, factory, owner, adminSigner, opponentWalletAddress } =
        await loadFixture(deployFixture);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const request = withFactory(factory, {
        gameId: await generateGameId(612n),
        amount: ethers.parseEther("3"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 1);

      await expect(
        relayReleaseExpiredTx(factory, owner, walletAddress, EMPTY_SIG)
      ).to.be.revertedWithCustomError(factory, "ECDSAInvalidSignatureLength");

      const badSig = await signReleaseExpired(owner, factoryDomain, walletAddress);
      await expect(
        relayReleaseExpiredTx(factory, owner, walletAddress, badSig)
      ).to.be.revertedWithCustomError(factory, "InvalidSignature");
    });

    it("allows the wallet owner to release expired reservations directly", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(deployFixture);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const request = withFactory(factory, {
        gameId: await generateGameId(701n),
        amount: ethers.parseEther("1.5"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 1);
      await wallet.connect(owner).releaseExpired();

      const totalsAfter = await wallet.getTotalReserved();
      expect(totalsAfter[0]).to.equal(0n);
      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

    it("prevents non-owners from releasing expired reservations directly", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress, stranger } =
        await loadFixture(deployFixture);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const request = withFactory(factory, {
        gameId: await generateGameId(702n),
        amount: ethers.parseEther("2"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const reserveSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, reserveSig);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 1);

      await expect(wallet.connect(stranger).releaseExpired()).to.be.revertedWithCustomError(
        wallet,
        "SenderNotAllowed"
      );

      await wallet.connect(owner).releaseExpired();
      const totalsAfter = await wallet.getTotalReserved();
      expect(totalsAfter[0]).to.equal(0n);
    });

    it("no limit to active wagers and releases ether after ttl", async () => {
      const { chainId, wallet, walletAddress, factory, owner, adminSigner, opponentWalletAddress, factoryOwner } =
        await loadFixture(deployFixture);

      const extendedTtl = 3600;
      await factory.connect(factoryOwner).setReservationTtl(extendedTtl);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      for (let i = 0; i < 100; i++) {
        const request = withFactory(factory, {
          gameId: await generateGameId(BigInt(1000 + i)),
          amount: ethers.parseEther("0.01"),
          player1: walletAddress,
          player2: opponentWalletAddress,
          isToken: false,
          ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        });
        const sig = await signReserve(adminSigner, factoryDomain, request);
        await relayReserveTx(factory, owner, request, sig);
        bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      }

      const totals = await wallet.calculateTotalReserved();
      expect(totals[0]).to.equal(ethers.parseEther("0.01") * BigInt(100));
      expect(totals[1]).to.equal(0n);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 200);

      const newTotals = await wallet.calculateTotalReserved();
      expect(newTotals[0]).to.equal(0n);
      expect(newTotals[1]).to.equal(0n);

      const walletBalanceBefore = await ethers.provider.getBalance(walletAddress);
      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
      const withdrawTx = await wallet.connect(owner).withdraw(walletBalanceBefore);
      const receipt = await withdrawTx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
      expect(ownerBalanceAfter + gasUsed - ownerBalanceBefore).to.equal(walletBalanceBefore);
      const walletBalanceAfter = await ethers.provider.getBalance(walletAddress);
      expect(walletBalanceAfter).to.equal(0n);
    });

    it("rotates the admin signer and invalidates old signatures", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        adminSigner,
        factoryOwner,
        owner,
        opponentWallet,
        opponentWalletAddress,
        stranger,
      } =
        await loadFixture(deployFixture);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const baseFields = {
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
      };
      const request1 = withFactory(factory, {
        ...baseFields,
        gameId: await generateGameId(601n),
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const sig1 = await signReserve(adminSigner, factoryDomain, request1);
      await relayReserveTx(factory, owner, request1, sig1);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const newSigner = stranger;
      const invalidRequest = withFactory(factory, {
        ...baseFields,
        gameId: await generateGameId(602n),
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const invalidSig = await signReserve(newSigner, factoryDomain, invalidRequest);
      await expect(relayReserveTx(factory, owner, invalidRequest, invalidSig)).to.be.revertedWithCustomError(
        factory,
        "InvalidSignature"
      );

      // set newSigner as the new signer
      await factory.connect(factoryOwner).setApprover(newSigner.address);

      const newRequest = withFactory(factory, {
        ...baseFields,
        gameId: await generateGameId(603n),
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const newSignerSig = await signReserve(newSigner, factoryDomain, newRequest);
      await relayReserveTx(factory, owner, newRequest, newSignerSig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const cancelSig = await signCancel(newSigner, factoryDomain, newRequest.gameId);
      await relayCancelTx(
        factory,
        owner,
        walletAddress,
        opponentWalletAddress,
        newRequest.gameId,
        cancelSig
      );
    });

    it("returns owner and factory metadata", async () => {
      const { wallet, factory, owner } = await loadFixture(deployFixture);
      const info = await wallet.getOwnerAndFactory();
      expect(info[0]).to.equal(owner.address);
      expect(info[1]).to.equal(factory.target);
    });

    it("accepts plain ether transfers", async () => {
      const { wallet, user } = await loadFixture(deployFixture);
      const before = await ethers.provider.getBalance(wallet.target);
      await user.sendTransaction({ to: wallet.target, value: ethers.parseEther("5") });
      const after = await ethers.provider.getBalance(wallet.target);
      expect(after - before).to.equal(ethers.parseEther("5"));
    });

    it("only owner can set and unset approval", async () => {
      const { wallet, owner, factoryOwner } = await loadFixture(deployFixture);

      expect(await wallet.getApprovalRequired()).to.equal(false);
      await wallet.connect(owner).setApprovalRequired(true);
      expect(await wallet.getApprovalRequired()).to.equal(true);

      await expect(wallet.connect(factoryOwner).setApprovalRequired(false)).to.be.revertedWithCustomError(
        wallet,
        "SenderNotAllowed"
      );
      await wallet.connect(owner).setApprovalRequired(false);
      expect(await wallet.getApprovalRequired()).to.equal(false);
    });

    it("approval requirement is honored", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        owner,
        adminSigner,
        factoryOwner,
        stranger,
        opponentWalletAddress,
      } =
        await loadFixture(deployFixture);

      expect(await wallet.getApprovalRequired()).to.equal(false);
      await wallet.connect(owner).setApprovalRequired(true);
      expect(await wallet.getApprovalRequired()).to.equal(true);

      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(800n),
        amount: ethers.parseEther("2"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const walletDomain = buildWalletDomain(walletAddress, chainId);
      const badSig = await signReserve(stranger, walletDomain, request);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await expect(
        relayReserveTx(
          factory,
          owner,
          request,
          sig,
          {
            [ethers.getAddress(walletAddress)]: badSig,
          }
        )
      ).to.be.revertedWithCustomError(wallet, "BadSignature");

      const ownerSig = await signReserve(owner, walletDomain, request);
      const goodSig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(
        factory,
        owner,
        request,
        goodSig,
        {
          [ethers.getAddress(walletAddress)]: ownerSig,
        }
      );
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const [, , , , foundBefore] = await wallet.getReservationDetails(request.gameId);
      expect(foundBefore).to.equal(false);

      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: walletAddress,
      });
      const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);
      await relaySettleTx(factory, owner, settlement, settleSig);
      const [, , , , foundAfter] = await wallet.getReservationDetails(request.gameId);
      expect(foundAfter).to.equal(false);
    });

    it("allows only the owner to approve pending reservations", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, stranger, opponentWalletAddress, owner } =
        await loadFixture(deployFixture);
      await wallet.connect(owner).setApprovalRequired(true);

      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(810n),
        amount: ethers.parseEther("1"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const walletDomain = buildWalletDomain(walletAddress, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      const wrongSig = await signReserve(stranger, walletDomain, request);
      await expect(
        relayReserveTx(
          factory,
          owner,
          request,
          sig,
          {
            [ethers.getAddress(walletAddress)]: wrongSig,
          }
        )
      ).to.be.revertedWithCustomError(wallet, "BadSignature");
    });

    it("approves owner reservations when approval required", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        owner,
        adminSigner,
        opponent,
        opponentWallet,
        opponentWalletAddress,
      } = await loadFixture(deployFixture);
      await wallet.connect(owner).setApprovalRequired(true);
      await opponentWallet.connect(opponent).setApprovalRequired(true);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(820n),
        amount: ethers.parseEther("4"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: false,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const walletDomain = buildWalletDomain(walletAddress, chainId);
      const opponentDomain = buildWalletDomain(opponentWalletAddress, chainId);

      const sig = await signReserve(adminSigner, factoryDomain, request);
      const ownerSig = await signReserve(owner, walletDomain, request);
      const oppSig = await signReserve(opponent, opponentDomain, request);
      await relayReserveTx(
        factory,
        owner,
        request,
        sig,
        {
          [ethers.getAddress(walletAddress)]: ownerSig,
          [ethers.getAddress(opponentWalletAddress)]: oppSig
        }
      );
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

  });

  describe("token reservations", () => {
    async function setupTokenFixture() {
      const context = await deployFixture();
      const { walletAddress, token, opponentWalletAddress } = context;
      const deposit = ethers.parseEther("1000");
      await token.transfer(walletAddress, deposit);
      await token.transfer(opponentWalletAddress, deposit);
      return { ...context, deposit };
    }

    it("can transfer tokens to the battle wallet", async () => {
      const { walletAddress, token, adminSigner } = await loadFixture(deployFixture);
      await token.transfer(walletAddress, ethers.parseEther("500"));
      const balance = await token.connect(adminSigner).balanceOf(walletAddress);
      expect(balance).to.equal(ethers.parseEther("500"));
    });

    it("prevents withdrawals beyond available tokens", async () => {
      const { wallet, token, owner, adminSigner } = await loadFixture(setupTokenFixture);
      // send tokens to the battle wallet
      const initialBalance = await token.balanceOf(owner.address);
      await expect(wallet.connect(owner).withdrawToken(ethers.parseEther("1001")))
        .to.be.revertedWithCustomError(wallet, "InsufficientFunds");

      await expect(wallet.connect(adminSigner).withdrawToken(1n)).to.be.revertedWithCustomError(
        wallet,
        "SenderNotAllowed"
      );
      await wallet.connect(owner).withdrawToken(ethers.parseEther("100"));
      const balance = await token.balanceOf(owner.address);
      expect(balance - initialBalance).to.be.greaterThan(0n);
    });

    it("reserves and settles token wagers when wallet loses", async () => {
      const { chainId, walletAddress, factory, owner, adminSigner, opponentWalletAddress, token, feeWallet } =
        await loadFixture(setupTokenFixture);
      await token.connect(owner).transfer(opponentWalletAddress, ethers.parseEther("50"));
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(900n),
        amount: ethers.parseEther("20"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: true,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        feeWallet: feeWallet.address,
        feeBasisPoints: 500,
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, sig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: opponentWalletAddress,
        loser: walletAddress,
      });
      const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);
      const opponentBefore = await token.balanceOf(opponentWalletAddress);
      const feeBefore = await token.balanceOf(feeWallet.address);
      await relaySettleTx(factory, owner, settlement, settleSig);

      const opponentAfter = await token.balanceOf(opponentWalletAddress);
      const feeAfter = await token.balanceOf(feeWallet.address);
      expect(opponentAfter - opponentBefore).to.equal(ethers.parseEther("19"));
      expect(feeAfter - feeBefore).to.equal(ethers.parseEther("1"));
    });

    it("reserves and settles token wagers when wallet wins", async () => {
      const { chainId, walletAddress, factory, adminSigner, owner, opponentWalletAddress, token } =
        await loadFixture(setupTokenFixture);
      await token.connect(owner).transfer(opponentWalletAddress, ethers.parseEther("50"));
      const initialTokBalance = await token.balanceOf(walletAddress);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(901n),
        amount: ethers.parseEther("15"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: true,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, sig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const settlement = withFactory(factory, {
        gameId: request.gameId,
        winner: walletAddress,
        loser: opponentWalletAddress,
      });
      const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);
      await relaySettleTx(factory, owner, settlement, settleSig);

      const finalTokBalance = await token.balanceOf(walletAddress);
      expect(finalTokBalance - initialTokBalance).to.equal(ethers.parseEther("15"));
    });

    it("cancels token reservations", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } = await loadFixture(
        setupTokenFixture
      );
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(902n),
        amount: ethers.parseEther("7"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: true,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, sig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const cancelSig = await signCancel(adminSigner, factoryDomain, request.gameId);
      await relayCancelTx(
        factory,
        owner,
        walletAddress,
        opponentWalletAddress,
        request.gameId,
        cancelSig
      );
      const totals = await wallet.getTotalReserved();
      expect(totals[1]).to.equal(0n);
      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

    it("releases expired token reservations on signer request", async () => {
      const { chainId, wallet, walletAddress, factory, adminSigner, owner, opponentWalletAddress } =
        await loadFixture(setupTokenFixture);
      const nonces = new Map();
      const request = withFactory(factory, {
        gameId: await generateGameId(903n),
        amount: ethers.parseEther("9"),
        player1: walletAddress,
        player2: opponentWalletAddress,
        isToken: true,
        ...assignNonces(nonces, walletAddress, opponentWalletAddress),
      });
      const factoryDomain = buildFactoryDomain(factory, chainId);
      const sig = await signReserve(adminSigner, factoryDomain, request);
      await relayReserveTx(factory, owner, request, sig);
      bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 10);
      const releaseSig = await signReleaseExpired(adminSigner, factoryDomain, walletAddress);
      await relayReleaseExpiredTx(factory, owner, walletAddress, releaseSig);
      const totals = await wallet.getTotalReserved();
      expect(totals[1]).to.equal(0n);
      const [, , , , found] = await wallet.getReservationDetails(request.gameId);
      expect(found).to.equal(false);
    });

    it("no limit to wagers and releases after ttl", async () => {
      const {
        chainId,
        wallet,
        walletAddress,
        factory,
        owner,
        adminSigner,
        factoryOwner,
        opponentWalletAddress,
        token,
        deposit,
      } = await loadFixture(setupTokenFixture);

      const extendedTtl = 3600;
      await factory.connect(factoryOwner).setReservationTtl(extendedTtl);

      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      for (let i = 0; i < 200; i++) {
        const request = withFactory(factory, {
          gameId: await generateGameId(BigInt(2000 + i)),
          amount: ethers.parseEther("0.01"),
          player1: walletAddress,
          player2: opponentWalletAddress,
          isToken: true,
          ...assignNonces(nonces, walletAddress, opponentWalletAddress),
        });
        const sig = await signReserve(adminSigner, factoryDomain, request);
        await relayReserveTx(factory, owner, request, sig);
        bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddress);
      }

      const totals = await wallet.calculateTotalReserved();
      expect(totals[0]).to.equal(0n);
      expect(totals[1]).to.equal(ethers.parseEther("0.01") * BigInt(200));

      const ttl = await factory.reservationTtl();
      await time.increase(Number(ttl) + 200);

      const newTotals = await wallet.calculateTotalReserved();
      expect(newTotals[0]).to.equal(0n);
      expect(newTotals[1]).to.equal(0n);

      const walletTokenBalanceBefore = await token.balanceOf(walletAddress);
      expect(walletTokenBalanceBefore).to.equal(deposit);
      const ownerTokenBefore = await token.balanceOf(owner.address);
      await wallet.connect(owner).withdrawToken(walletTokenBalanceBefore);
      const ownerTokenAfter = await token.balanceOf(owner.address);
      expect(ownerTokenAfter - ownerTokenBefore).to.equal(walletTokenBalanceBefore);
      const walletTokenBalanceAfter = await token.balanceOf(walletAddress);
      expect(walletTokenBalanceAfter).to.equal(0n);
    });

  });

  describe("large scale lifecycle management", () => {
    async function setupMassFixture() {
      const [owner, factoryOwner, adminSigner, feeWallet, opponentOne, opponentTwo, opponentThree] =
        await ethers.getSigners();
      const { chainId } = await ethers.provider.getNetwork();

      const Wallet = await ethers.getContractFactory("BattleWallet");
      const walletImplementation = await Wallet.deploy();
      await walletImplementation.waitForDeployment();

      const Token = await ethers.getContractFactory("TestToken");
      const tokenSupply = ethers.parseEther("1000000");
      const token = await Token.deploy("Stress Token", "STRESS", 18, tokenSupply, owner.address);
      await token.waitForDeployment();

      const Factory = await ethers.getContractFactory("BattleWalletFactory");
      const factory = await Factory.deploy(
        walletImplementation.target,
        factoryOwner.address,
        adminSigner.address,
        token.target,
      );
      await factory.waitForDeployment();

      await factory.connect(factoryOwner).setReservationTtl(3000);

      const walletAddress = await factory.predictBattleWalletAddress(owner.address);
      await factory.deployBattleWallet(owner.address);
      const wallet = await ethers.getContractAt("BattleWallet", walletAddress);

      const opponents = [opponentOne, opponentTwo, opponentThree];
      const opponentWalletAddresses = [];
      const opponentWallets = [];

      for (const opponent of opponents) {
        const predicted = await factory.predictBattleWalletAddress(opponent.address);
        await factory.deployBattleWallet(opponent.address);
        const opponentWallet = await ethers.getContractAt("BattleWallet", predicted);
        opponentWalletAddresses.push(predicted);
        opponentWallets.push(opponentWallet);
        await opponent.sendTransaction({ to: predicted, value: ethers.parseEther("1000") });
      }

      await owner.sendTransaction({ to: walletAddress, value: ethers.parseEther("1000") });

      const tokenDeposit = ethers.parseEther("1000");
      await token.transfer(walletAddress, tokenDeposit);
      for (const opponentWalletAddress of opponentWalletAddresses) {
        await token.transfer(opponentWalletAddress, tokenDeposit);
      }

      return {
        wallet,
        walletAddress,
        factory,
        token,
        owner,
        adminSigner,
        feeWallet,
        opponentWallets,
        opponentWalletAddresses,
        chainId,
      };
    }


    it("processes large batch of wagers", async function () {
      this.timeout(120000);
      const {
        wallet,
        walletAddress,
        factory,
        token,
        owner,
        adminSigner,
        feeWallet,
        opponentWallets,
        opponentWalletAddresses,
        chainId,
      } = await loadFixture(setupMassFixture);
      let games = [];
      let abandonedGames = [];
      let expectedEthDelta = 0n;
      let expectedTokenDelta = 0n;
      let activeGames = 0;
      let gameCtr = 0;
      const nonces = new Map();
      const factoryDomain = buildFactoryDomain(factory, chainId);
      async function makeGame() {
        const isToken = Math.random() >= 0.5;
        const opponentIndex = randomInt(0, opponentWallets.length-1);
        const request = withFactory(factory, {
          gameId: await generateGameId(BigInt(5000 + gameCtr)),
          amount: ethers.parseEther("0.1"),
          player1: walletAddress,
          player2: opponentWalletAddresses[opponentIndex],
          isToken,
          ...assignNonces(nonces, walletAddress, opponentWalletAddresses[opponentIndex]),
        });
        const reserveSig = await signReserve(adminSigner, factoryDomain, request);
        await relayReserveTx(factory, owner, request, reserveSig);
        bumpNoncesAfterReserve(nonces, walletAddress, opponentWalletAddresses[opponentIndex]);
        games.push(request);
        activeGames++;
        gameCtr++;
      }

      // seed with 50 active games first
      for (let i=0; i<50; i++) {
        await makeGame();
      }
      // mine a block, then wait for txns to complete
      //await network.provider.send("evm_mine");

      for (let j=0; j<1000; j++) {
        // from here on, is one in one out, with 
        // small chance of an abandoned game
        const gameToFinalize = popRandomElement(games);
        const resolutionVal = Math.random();
        let winner = gameToFinalize.player1; // primary user
        let loser = gameToFinalize.player2;
        if (resolutionVal <= 0.40) {
          // flip  winner and loser.  slightly higher chance of winning
          winner = gameToFinalize.player2;
          loser = gameToFinalize.player1;
        }
        // chance of setting a random game
        // always settle if we have > 50 active games, 
        // since abandoned ones will accumulate
        if (resolutionVal >= 0.98 && abandonedGames.length < 20) {
          abandonedGames.push(gameToFinalize);
        } else {
          // > 0.9 => expires with no result
          let userDelta = (winner == walletAddress ? gameToFinalize.amount : -1n * gameToFinalize.amount);
          if (gameToFinalize.isToken) {
            expectedTokenDelta += userDelta;
          } else {
            expectedEthDelta += userDelta;
          }
          // relay settlement
          const settlement = withFactory(factory, {
            gameId: gameToFinalize.gameId,
            winner,
            loser,
          });
          const settleSig = await signSettlement(adminSigner, factoryDomain, settlement);
          await relaySettleTx(factory, owner, settlement, settleSig);
          activeGames--;
        }
        await makeGame();
        if (j%50 == 0) {
          // mine a block
          await network.provider.send("evm_mine");
        }
      }
      // the rest will be abandoned now, and nothing reserved
      await time.increase(100000);
      const storedTotals = await wallet.getTotalReserved();
      expect(storedTotals[0]).to.greaterThan(0n);
      expect(storedTotals[1]).to.greaterThan(0n);
      const totals = await wallet.calculateTotalReserved();
      expect(totals[0]).to.equal(0n);
      expect(totals[1]).to.equal(0n);
      const releaseSig = await signReleaseExpired(adminSigner, factoryDomain, walletAddress);
      await relayReleaseExpiredTx(factory, owner, walletAddress, releaseSig);
      const newStoredTotals = await wallet.getTotalReserved();
      expect(newStoredTotals[0]).to.equal(0n);
      expect(newStoredTotals[1]).to.equal(0n);
      const newTotals = await wallet.calculateTotalReserved();
      expect(newTotals[0]).to.equal(0n);
      expect(newTotals[1]).to.equal(0n);
    });
  });

  describe("proxy upgrades", () => {
    async function deployUpgradeImplementation() {
      const WalletV2 = await ethers.getContractFactory("BattleWalletV2");
      const implementation = await WalletV2.deploy();
      await implementation.waitForDeployment();
      return implementation;
    }

    it("requires owner signature to upgrade wallet", async () => {
      const { chainId, factory, walletAddress, owner, factoryOwner } = await loadFixture(deployFixture);
      const proxy = await ethers.getContractAt("BattleWalletProxy", walletAddress);
      const newImplementation = await deployUpgradeImplementation();

      const nonce = await proxy.upgradeNonce();
      await expect(
        factory
          .connect(factoryOwner)
          .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", EMPTY_SIG)
      ).to.be.revertedWithCustomError(proxy, "InvalidSignature");

      const proxyDomain = buildProxyDomain(walletAddress, chainId);
      const signature = await signUpgrade(owner, proxyDomain, walletAddress, newImplementation.target, "0x", nonce);

      await expect(
        factory
          .connect(factoryOwner)
          .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", signature)
      )
        .to.emit(factory, "BattleWalletUpgraded")
        .withArgs(walletAddress, newImplementation.target);

      const upgradedWallet = await ethers.getContractAt("BattleWalletV2", walletAddress);
      expect(await upgradedWallet.version()).to.equal(2n);
    });

    it("increments upgrade nonce and prevents signature reuse", async () => {
      const { chainId, factory, walletAddress, owner, factoryOwner } = await loadFixture(deployFixture);
      const proxy = await ethers.getContractAt("BattleWalletProxy", walletAddress);
      const newImplementation = await deployUpgradeImplementation();

      const nonce = await proxy.upgradeNonce();
      const proxyDomain = buildProxyDomain(walletAddress, chainId);
      const signature = await signUpgrade(owner, proxyDomain, walletAddress, newImplementation.target, "0x", nonce);

      await factory
        .connect(factoryOwner)
        .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", signature);

      const nextNonce = await proxy.upgradeNonce();
      expect(nextNonce).to.equal(nonce + 1n);

      await expect(
        factory
          .connect(factoryOwner)
          .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", signature)
      ).to.be.revertedWithCustomError(proxy, "InvalidSignature");
    });

    it("only allows factory admin to perform upgrades", async () => {
      const { chainId, factory, walletAddress, owner, factoryOwner } = await loadFixture(deployFixture);
      const newImplementation = await deployUpgradeImplementation();
      const proxy = await ethers.getContractAt("BattleWalletProxy", walletAddress);
      const nonce = await proxy.upgradeNonce();
      const proxyDomain = buildProxyDomain(walletAddress, chainId);
      const signature = await signUpgrade(owner, proxyDomain, walletAddress, newImplementation.target, "0x", nonce);

      await expect(
        factory
          .connect(owner)
          .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", signature)
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      await factory
        .connect(factoryOwner)
        .upgradeBattleWallet(walletAddress, newImplementation.target, "0x", signature);
    });
  });
});
