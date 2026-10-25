# Starbound Realms — Architecture

This document describes the technical architecture of Starbound Realms: how the system is structured, how data flows between layers, and the design decisions behind each component.

---

## System Overview

Starbound Realms is a fully on-chain strategy game. All authoritative game state lives in Soroban smart contracts on the Stellar network. No central server can alter, pause, or roll back game state — only valid on-chain transactions can change it.

The system has four layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Smart Contracts (Soroban / Rust)                            │
│     Authoritative game state. All writes go here.              │
├─────────────────────────────────────────────────────────────────┤
│  2. TypeScript SDK                                              │
│     Typed wrappers around contract invocations.                │
│     Used by both the frontend and backend.                      │
├─────────────────────────────────────────────────────────────────┤
│  3. Backend (Node.js + Express + PostgreSQL)                    │
│     Read-only indexer. Listens to contract events,             │
│     caches state in Postgres, exposes REST API.                │
├─────────────────────────────────────────────────────────────────┤
│  4. Frontend (React + Vite)                                     │
│     Game UI. Reads from backend API, writes via SDK to chain.  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Write Path (state mutations)

```
Player (browser)
  → signs transaction with Freighter wallet
  → TypeScript SDK builds & submits XDR transaction
  → Soroban RPC forwards to Stellar network
  → Soroban contract executes
  → New state written to contract storage
  → Contract event emitted
```

### Read Path (state queries)

```
Frontend
  → HTTP GET to Backend REST API
  → Backend queries PostgreSQL
  → Returns JSON response
```

### Indexer Path (chain → database)

```
Soroban contract emits event
  → Backend eventListener.ts polls Soroban RPC
  → processor.ts decodes event payload
  → Writes structured record to PostgreSQL
```

---

## Smart Contracts

### Design Principles

- Each contract is independently deployable and upgradeable
- Contracts communicate via cross-contract calls, not shared storage
- All state-mutating functions require Soroban auth (`env.require_auth`)
- Randomness uses Soroban's built-in `Prng` — seeded per-ledger, verifiable

### `galaxy-map` Contract

**Storage schema:**
```
Key: SystemId (u32)
Value: StarSystem {
  owner: Option<Address>,
  coord_x: u32,
  coord_y: u32,
  resource_type: ResourceType,   // Iron | Energy | Plasma
  resource_yield: u32,
  defense_rating: u32,
  last_claimed: u64,
  upgrade_level: u32,            // defense upgrades, starts at 0
}
```

`upgrade_level` was added to the serialized `StarSystem` shape after the first
testnet deployment. New deployments initialize it to `0`. Existing deployed
galaxies must be redeployed (or migrated with an explicitly versioned contract
upgrade) before clients that decode the new shape are pointed at them; Soroban
does not supply a default for a missing struct field. The current testnet
deployment predates this field and is therefore not a compatible target for
the upgrade-aware client until it is redeployed.

**Grid size limit:** `initialize` writes one persistent storage entry per system
in a single transaction (looping `grid_size × grid_size` times). A `grid_size`
of **8** (64 systems) was deployed successfully on Stellar testnet in October
2026. Testing confirms that **16** (256 systems) is the largest value that
reliably fits within Soroban's per-transaction resource limits on testnet.
The contract therefore enforces `MAX_GRID_SIZE = 16` and panics with
`"grid_size exceeds maximum of 16"` if a larger value is passed to `initialize`.
Values above 16 have not been verified and are expected to fail with a Soroban
resource-limit error.

**Events emitted:** `system_claimed`, `ownership_transferred`

---

### `resources` Contract

Resources are issued as real Stellar classic assets — balances live in the Stellar account ledger and are tradeable on the Stellar DEX.

| Name | Symbol | Use |
|---|---|---|
| Iron | `IRON` | Fleet construction |
| Energy | `NRGY` | Fleet movement & upkeep |
| Plasma | `PLSM` | Advanced units & upgrades |

**Events emitted:** `resources_mined`, `resources_spent`

---

### `fleet` Contract

**Storage schema:**
```
Key: Address (player)
Value: Fleet {
  units: Map<UnitType, u32>,
  location: u32,
  last_moved: u64,
}
```

| Unit | Attack | Defense | Cost (IRON/NRGY) |
|---|---|---|---|
| Scout | 2 | 1 | 10 / 5 |
| Fighter | 5 | 3 | 25 / 15 |
| Cruiser | 12 | 8 | 60 / 40 |
| Dreadnought | 30 | 20 | 150 / 100 |

**Events emitted:** `units_built`, `fleet_moved`

---

### `battle` Contract

Combat algorithm:
1. Load attacker fleet stats
2. Load defender fleet stats + system defense bonus
3. Roll combat rounds via `Prng`
4. Losing side loses units proportional to damage dealt
5. Winner takes the system via `galaxy-map.transfer_ownership`
6. Emit `battle_resolved` event

**Events emitted:** `battle_resolved`

---

## Backend

### Indexer

Polls Soroban RPC for contract events across all four contract IDs. Decodes and writes to PostgreSQL.

**Tables:** `star_systems`, `resource_events`, `fleet_snapshots`, `battles`, `players`

### REST API (read-only)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/galaxy` | Full galaxy grid |
| GET | `/galaxy/:systemId` | Single system |
| GET | `/player/:address` | Player profile |
| GET | `/player/:address/fleet` | Player fleet |
| GET | `/player/:address/battles` | Battle history |
| GET | `/battles` | Recent battles (paginated) |
| GET | `/battles/:battleId` | Single battle |
| GET | `/leaderboard` | Top players |

---

## Environment Variables

**Backend `.env`:**
```
DATABASE_URL=postgres://...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
CONTRACT_GALAXY_MAP=C...
CONTRACT_RESOURCES=C...
CONTRACT_FLEET=C...
CONTRACT_BATTLE=C...
INDEXER_POLL_INTERVAL_MS=5000
PORT=3000
```

**Frontend `.env`:**
```
VITE_BACKEND_URL=http://localhost:3000
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_CONTRACT_GALAXY_MAP=C...
VITE_CONTRACT_RESOURCES=C...
VITE_CONTRACT_FLEET=C...
VITE_CONTRACT_BATTLE=C...
```

---

## Trustlines: Mining Setup Flow

This section documents a Stellar-specific requirement that every new contributor should understand
before touching resource, mining, or wallet-connection code. Missing this caused real debugging
time during the October 2026 testnet cycle.

### Why classic assets need trustlines

The three in-game resources — Iron (`IRON`), Energy (`NRGY`), and Plasma (`PLSM`) — are real Stellar
classic assets, not synthetic Soroban-native tokens. In Stellar's classic account model, an account
cannot receive an asset it hasn't explicitly opted in to. That opt-in is called a **trustline**. If the
`resources` contract tries to mint to a player who has no trustline for `IRON`, the transaction fails
with `"trustline entry is missing"` — the contract can do nothing about it.

This is not a bug or a workaround; it's the intended Stellar model. It gives players explicit control
over what their account holds and prevents spam assets from appearing in wallets.

### The three SDK methods

All trustline logic lives in `sdk/src/resources.ts` inside `ResourcesClient`:

#### `buildTrustlineKey(playerAddress, assetCode, issuer) → xdr.LedgerKey`

Builds an `xdr.LedgerKey` of type `trustline` for one asset. Used internally to check the ledger in a
single batch request.

#### `findMissingTrustlines(playerAddress, issuer) → Promise<string[]>`

Queries `getLedgerEntries` with all three trustline keys in **one request** (not three separate calls).
Returns only the asset codes (`'IRON'`, `'NRGY'`, `'PLSM'`) whose trustline does not exist yet on the
ledger. Returns an empty array if all three are already established.

```ts
// Internally builds three ledger keys and checks them in one round-trip:
const keys = RESOURCE_ASSET_CODES.map((code) => buildTrustlineKey(player, code, issuer));
const { entries } = await server.getLedgerEntries(...keys);
// diff keys vs entries to find the missing ones
```

#### `establishTrustlines(playerAddress, issuer, sign) → Promise<void>`

Calls `findMissingTrustlines` first. If the result is empty, returns immediately — it is safe to call on
every wallet connect without generating a signature prompt when nothing is needed. Otherwise it builds one
classic transaction containing a `ChangeTrust` operation for each missing asset and submits it. The player
signs exactly once regardless of how many trustlines are missing.

```ts
// Only called when missing.length > 0:
await client.submitClassicTransaction({
  sourceAddress: playerAddress,
  operations: missing.map((code) => Operation.changeTrust({ asset: new Asset(code, issuer) })),
  sign,
});
```

### Where this is wired into the UI

1. **`frontend/src/hooks/useTrustlines.ts`**
   - Runs `findMissingTrustlines` automatically when `walletAddress` changes (on wallet connect).
   - Exposes `{ missing, isLoading, isSettingUp, setUpTrustlines }` to its callers.
   - Never calls `establishTrustlines` on its own — the player must explicitly trigger `setUpTrustlines`.

2. **`frontend/src/components/ResourceSetupBanner.tsx`**
   - Renders only when `missing` is non-empty.
   - Shows a yellow banner: `"Your wallet can't hold IRON, NRGY, PLSM yet."` with a **Set up resources**
     button.
   - The button calls `setUpTrustlines`, which calls `establishTrustlines` in the SDK, which requests one
     Freighter signature for the whole batch.
   - After the transaction is confirmed, `useTrustlines` re-checks the ledger and sets `missing` to `[]`,
     which hides the banner.

### Sequence diagram

```
wallet connects
  → useTrustlines detects walletAddress change
  → findMissingTrustlines() → getLedgerEntries (one request)
  → missing = ['IRON', 'NRGY', 'PLSM']   (or subset, or [])

if missing is non-empty:
  → ResourceSetupBanner renders
  → player clicks "Set up resources"
  → setUpTrustlines() → establishTrustlines()
  → one ChangeTrust tx, player signs once in Freighter
  → tx confirmed on Stellar testnet
  → findMissingTrustlines() re-run → missing = []
  → banner disappears, mining and resource receipt work
```

### Common mistakes to avoid

- **Do not remove the banner or skip `findMissingTrustlines`** — the missing trustline causes a silent
  on-chain failure; the player just never receives resources.
- **Do not call `establishTrustlines` automatically on wallet connect** — it would prompt for a signature
  without player intent. Always gate it behind a UI action.
- **Do not add a separate trustline check per asset** — `findMissingTrustlines` batches all three into one
  `getLedgerEntries` call deliberately. Splitting it into three calls triples round-trips for no benefit.

---

## Security Considerations

- No admin keys in contracts
- Auth enforced at contract level via `env.require_auth`
- Soroban replay prevention built-in
- Backend is read-only, holds no signing keys
- Frontend never holds private keys — all signing via Freighter
