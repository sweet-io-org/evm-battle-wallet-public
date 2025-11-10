# SCOR Battle Wallet

This contract facilitates wagering between two parties.  Each party will have control
over a BattleWallet contract, and will deposit Eth or an ERC-20 token with the BattleWallet.  
The Factory contract will establish Reservations between the
two parties, optionally with the ability of each party to approve individual Reservations.
The Reservation describes the counter-party, the wager amount, and the wager type (Eth or 
an ERC-20 token).  It will confirm the balance is available, and prevent withdraw until the 
Reservation is settled or cancelled.  On conclusion, the Factory transmits a Settlement to each party's 
contract, indicating the winner and the loser.  This will trigger payout from the winner 
to the loser, along with a fee transmitted to a 3rd party.  

Owners may withdraw funds from the BattleWallet at any time, up to an amount equal to the 
balance less any outstanding reservations.  Each Reservation has an expiration, and funds
are automatically released upon expiration if no Settlement is received.

## Design

The BattleWalletFactory deploys an ERC-1976 Proxy for each BattleWallet, to facilitate inexpensive
deployments and provide for upgrades with approval.  Because the BattleWallet holds funds
for the owner, upgrades cannot be performed without the owner's approval, which is 
required as a signature.

The factory relays reservations, settlements, and cancellations to each of the BattleWallet 
contracts involved, and ensures that both accept the instruction, or the transaction is
reverted.  A separate approval account is used to provide EIP-712 signatures for the actions,
so that any wallet with a signature can submit the transaction, allowing for higher throughput,
and relay of these messages does not modify the state of the Factory.

Each Reservation has a GameID.  These must be unique.  The BattleWallet will store the GameID
in a map, and reject if it already exists.  Each BattleWallet also has a nonce, to prevent 
replay.  The Nonce is only used for Reservations, and must be provided in the signature for 
the Factory and the signatures for approval.

The Reservations are tracked in each wallet as a Linked List. The Factory determines the 
expiration based on the current block timestamp, and the Linked List will be in order of 
increasing expiration. Removal and release of Reservation relies on this order.  Note that if 
the TTL of the Factory is modified, releasing pre-existing Reservations may be delayed up to the new 
TTL value.


## Building

Build and test is via standard hardhat commands:

```shell
npx hardhat clean
npx hardhat compile
npx hardhat test
```

To store and check in build artifacts:

```
npx hardhat export-abi
npx hardhat export-bytecode
```

### Security Audit Tools

Slither audit (requires installing python and requirements.txt):

```shell
slither . --triage-mode
```

Mythril audit

```shell
myth analyze contracts/BattleWallet.sol --solc-json solc.json
myth analyze contracts/BattleWalletFactory.sol --solc-json solc.json
```

## Reservation lifecycle

Each reservation represents a wager between two BattleWallet proxies that locks either ETH or the configured ERC-20 token until it is settled, cancelled, or expires.

1. **Funding and configuration** – A wallet owner deposits ETH (and optionally tokens) into their BattleWallet proxy and may call `setApprovalRequired(true)` if they want to sign every wager. The factory admin configures the shared ERC-20 token during factory deployment and can adjust the reservation TTL with `setReservationTtl`.
2. **Reservation request** – The factory relays a `reserve` call to both participants. Each wallet verifies the shared approver signature, checks that the nonce matches its `nextNonce`, and ensures enough unreserved balance is available. The reservation is appended to a linked list ordered by expiration and the wagered amount is moved into the wallet's reserved balance. The new reservation stays active until settlement, cancellation, or expiry.
3. **Expiration** – Every reservation receives a fixed TTL from the factory (`reservationTtl`, default 3600 seconds). If the `expiration` timestamp is reached before the wager is settled, the reservation becomes eligible for release. Any subsequent state-changing call (reserve, withdraw, etc.) or an explicit `relayReleaseExpired` accompanied by the approver's signature (which now covers the `fullTraverse` flag and `expiresAt` deadline) will trigger `_releaseExpiredInternal`, prune expired entries from the head of the list, and free their balances. Expired reservations remain invisible to `getReservationDetails` until they are cleaned up.
4. **Settlement** – When the approver signs the results, `relaySettle` distributes the locked funds. The losing wallet enforces expiration and fee rules, while the winning wallet releases the reserved amount. Both wallets mark the reservation inactive.
5. **Cancellation** – The approver can sign a cancellation and `relayCancel` clears the reservation on both wallets, freeing the locked balance immediately.
6. **Withdrawal** – After expired reservations are released, the wallet owner can withdraw any unreserved ETH with `withdraw` or tokens with `withdrawToken`.

The reservation linked list guarantees that expirations are processed in chronological order, preventing a newer reservation with a longer TTL from blocking the release of older, shorter wagers.

## Operational examples

The following TypeScript snippets assume a Hardhat environment (`import { ethers } from "hardhat";`) and previously deployed factory & implementation contracts.

### 1. Deploy a BattleWallet

```ts
const factory = await ethers.getContractAt("BattleWalletFactory", factoryAddress);
const tx = await factory.deployBattleWallet(owner.address);
const receipt = await tx.wait();
const event = receipt.events?.find((evt) => evt.event === "BattleWalletDeployed");
const proxyAddress = event?.args?.proxy;
```

The proxy initializes itself via `initialize(owner)` and can immediately receive ETH or tokens. The deterministic address can be predicted with `factory.predictBattleWalletAddress(owner.address)` before deployment.

### 2. Upgrade and approve an upgrade

Upgrades require both the factory admin and the wallet owner:

```ts
const proxy = await ethers.getContractAt("BattleWalletProxy", proxyAddress);
const newImpl = "0x..."; // deployed BattleWallet implementation
const nonce = await proxy.upgradeNonce();
const chainId = (await ethers.provider.getNetwork()).chainId;

const signature = await owner._signTypedData(
  { name: "BattleWalletProxy", version: "1", chainId, verifyingContract: proxyAddress },
  {
    UPGRADE: [
      { name: "wallet", type: "address" },
      { name: "newImplementation", type: "address" },
      { name: "dataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
  },
  {
    wallet: proxyAddress,
    newImplementation: newImpl,
    dataHash: ethers.keccak256("0x"),
    nonce,
  }
);

await factory.connect(admin).upgradeBattleWallet(proxyAddress, newImpl, "0x", signature);
```

The proxy verifies the owner signature and increments its upgrade nonce to prevent replay.

### 3. Create a reservation without approval signatures

A wallet owner can opt out of per-reservation approvals. In the snippet below `opponentAddress` represents the opposing wallet proxy:

```ts
const wallet = await ethers.getContractAt("BattleWallet", proxyAddress);
const opponentWallet = await ethers.getContractAt("BattleWallet", opponentAddress);
await wallet.connect(owner).setApprovalRequired(false);

const reserveRequest = {
  gameId: 1n,
  amount: ethers.parseEther("0.1"),
  player1: proxyAddress,
  player2: opponentAddress,
  isToken: false,
  noncePlayer1: await wallet.getCurrentNonce(),
  noncePlayer2: await opponentWallet.getCurrentNonce(),
  feeWallet: treasury,
  feeBasisPoints: 250, // 2.5%
  factory: factoryAddress,
};

const approverSig = await approver._signTypedData(
  { name: "BattleWalletFactory", version: "1", chainId, verifyingContract: factoryAddress },
  {
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
  },
  reserveRequest
);

await factory.relayReserve(reserveRequest, approverSig, "0x", "0x");
```

Supplying `"0x"` for the player approvals is valid because both wallets have disabled the requirement.

### 4. Create approval signatures for a reservation

When `requireApproval` is `true`, each wallet owner must sign the same typed data that their wallet verifies. The snippet below reuses the `reserveRequest` object from the previous example, assumes `owner` and `opponent` are `Signer` instances for each player, and reuses `opponentAddress` from above:

```ts
const walletDomain = {
  name: "BattleWallet",
  version: "1",
  chainId,
  verifyingContract: proxyAddress,
};

const walletTypes = {
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

const playerApproval = await owner._signTypedData(walletDomain, walletTypes, reserveRequest);
const opponentApproval = await opponent._signTypedData(
  { ...walletDomain, verifyingContract: opponentAddress },
  walletTypes,
  reserveRequest
);

await factory.relayReserve(reserveRequest, approverSig, playerApproval, opponentApproval);
```

Each wallet compares the signature against its `owner()` and rejects mismatched nonces or factories.

### 5. Settle a reservation

After a match concludes, the approver signs the settlement payload and the factory relays it to both wallets:

```ts
const settlement = {
  gameId: 1n,
  winner: proxyAddress,
  loser: opponentAddress,
  factory: factoryAddress,
};

const settleSig = await approver._signTypedData(
  { name: "BattleWalletFactory", version: "1", chainId, verifyingContract: factoryAddress },
  {
    SETTLE: [
      { name: "gameId", type: "uint64" },
      { name: "winner", type: "address" },
      { name: "loser", type: "address" },
      { name: "factory", type: "address" },
    ],
  },
  settlement
);

await factory.relaySettle(settlement, settleSig);
```

The losing wallet enforces that the reservation has not expired and pays the fee, while the winning wallet releases the reserved balance.

The fee configuration is captured during reservation creation. Each wallet validates that `feeBasisPoints` does not exceed 2,500 and that a non-zero `feeWallet` is provided whenever a positive fee is requested.

### 6. Cancel a reservation

If a match cannot be played, the approver can cancel it:

```ts
const cancelSig = await approver._signTypedData(
  { name: "BattleWalletFactory", version: "1", chainId, verifyingContract: factoryAddress },
  {
    CANCEL: [
      { name: "gameId", type: "uint64" },
      { name: "factory", type: "address" },
    ],
  },
  { gameId: 1n, factory: factoryAddress }
);

await factory.relayCancel(proxyAddress, opponentAddress, 1n, cancelSig);
```

Both wallets mark the reservation inactive and emit `ReservationCancelled` events.

### 7. Withdraw funds

Wallet owners can reclaim unlocked balances at any time. The wallet releases expired reservations before calculating available funds:

```ts
await wallet.connect(owner).withdraw(ethers.parseEther("0.5"));
await wallet.connect(owner).withdrawToken(ethers.parseUnits("100", tokenDecimals));
```

If a reservation remains active, only the unreserved portion is withdrawable. Any relayer that supplies an approver-signed message can call `factory.relayReleaseExpired(proxyAddress, fullTraverse, expiresAt, signature)` to sweep expired reservations (using `fullTraverse = true` to force a full list scan when needed), and the wallet owner may always invoke `wallet.releaseExpired()` directly without the factory.

## Events

**BattleWalletFactory**

* `BattleWalletDeployed(address owner, address proxy, address implementation)` – Emitted after deploying a new proxy for `owner`.
* `WalletImplementationUpgraded(address newImplementation)` – Signals that newly deployed proxies will use `newImplementation`.
* `BattleWalletUpgraded(address proxy, address newImplementation)` – Indicates the factory upgraded a specific proxy.
* `AdminUpdated(address newAdmin)` – Announces a change to the factory administrator.
* `OwnerUpdated(address newOwner)` – Announces a change to the factory owner allowed to deploy wallets.
* `ApproverUpdated(address newApprover)` – Records a new approver account whose signatures are accepted by the factory.
* `TokenUpdated(address newToken)` – Broadcasts the shared ERC-20 token configured for wagers.
* `ReservationTtlUpdated(uint64 newTtl)` – Records an updated global reservation time-to-live in seconds.

**BattleWallet**

* `Reserved(uint64 gameId, address opponent, uint256 amount, bool isToken)` – Logs a new reservation and whether it locked ETH or tokens.
* `ReservationCancelled(uint64 gameId)` – Shows that a reservation was cancelled and funds were released.
* `ReservationSettled(uint64 gameId, address winner, address loser, uint256 amount, bool isToken)` – Emits after settlement indicating who won and the amount transferred.
* `ApprovalRequirementUpdated(bool requireApproval)` – Indicates whether the wallet owner must sign future reservations.
* `TokensWithdrawn(address from, uint256 amount)` – Reports ERC-20 withdrawals initiated by the owner.
* `EthWithdrawn(address from, uint256 amount)` – Reports ETH initiated by the owner.

## Read functions

* `getCurrentNonce()` – Returns the next reservation nonce that must be supplied in the factory signature for the wallet.
* `getTotalReserved()` – Reports the raw ETH and token balances currently reserved, including expired reservations that have not yet been swept.
* `calculateTotalReserved()` – Recalculates the reserved ETH and token totals after subtracting any reservations whose expiration timestamps have passed.
