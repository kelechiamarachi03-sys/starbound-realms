# Game Mechanics

This document describes the full game mechanics of Starbound Realms.

---

## The Galaxy

The galaxy is a procedurally generated grid of star systems, initialized once when the `galaxy-map` contract is deployed. The grid size is configurable at deploy time (e.g. 20×20 = 400 systems).

Each star system has:

| Property | Description |
|---|---|
| `coord_x`, `coord_y` | Grid coordinates — determines adjacency for fleet movement |
| `owner` | Stellar address of the current owner, or unclaimed |
| `resource_type` | One of: Iron, Energy, Plasma |
| `resource_yield` | Amount of resources produced per mining cycle (10–50 units) |
| `defense_rating` | Base defense value (5–20), adds to defender fleet stats in battle |
| `last_claimed` | Ledger timestamp of the last mining action |

---

## Claiming a System

Any player can claim an unclaimed star system by calling `galaxy-map.claim_system`. Requirements:
- The system must have no current owner
- The player must sign the transaction (Soroban auth enforced)

Once claimed, the system appears in the player's owned systems list and begins producing resources.

---

## Resources

Three resource types exist, each issued as a native Stellar asset:

| Resource | Symbol | Primary use |
|---|---|---|
| Iron | `IRON` | Build Scout, Fighter, Cruiser units |
| Energy | `NRGY` | Build Dreadnoughts, power fleet movement |
| Plasma | `PLSM` | Advanced units and future upgrades |

Since they are real Stellar assets, players can:
- Hold them in their Freighter wallet
- Trade them freely on the Stellar DEX
- Send them to other players

**Trustlines (one-time setup):** because these are classic Stellar assets, a player's account must trust each
one before it can receive any. Without that, a mint to the player fails with "trustline entry is missing". The
SDK's `ResourcesClient.establishTrustlines` creates all missing trustlines in a single transaction the player
signs, and does nothing if none are missing. In the app, a banner offers this once a wallet is connected; it
never prompts for a signature on its own.

**How resources are created today:** only through `resources.mint`, which is admin-only. There is no
player-callable mining function yet, so each system's `resource_yield` and `last_claimed` are stored but not
used. Passive mining (a player claiming their systems' yield) is planned, not implemented.

---

## Fleets

Each player has one fleet, tracked by the `fleet` contract. Fleets are composed of units:

| Unit | Attack | Defense | Iron cost | Energy cost |
|---|---|---|---|---|
| Scout | 2 | 1 | 10 | 5 |
| Fighter | 5 | 3 | 25 | 15 |
| Cruiser | 12 | 8 | 60 | 40 |
| Dreadnought | 30 | 20 | 150 | 100 |

**Building units:** Players call `fleet.build_unit`, spending resources from their balance. Units are added to their fleet immediately.

**Moving fleets:** Players call `fleet.move_fleet` to move to an adjacent system. Movement has a 60-second cooldown between moves.

- If the target system is **unclaimed** — the fleet moves and the player can claim it
- If the target system is **owned by another player** — the fleet moves there; moving doesn't fight
  automatically, see Battle below

---

## Battle

Battle is a separate, explicit action: a player calls `battle.resolve_battle(attacker, defender, system_id)`
directly, naming the system's current owner as the defender. It has no location requirement — an attacker's
fleet can be anywhere and still attack any system owned by someone else. (`fleet.move_fleet` only ever moves
a fleet; it never calls into the battle contract.)

**Resolution algorithm:**

1. Load attacker's total attack power (sum of all unit attack values). Each unit type counters one other type
   (Scout → Dreadnought → Cruiser → Fighter → Scout): a unit's attack is boosted 50% while the defender fleet
   contains its counter type. This matchup rule is proposed, see [seasonal-reset-design.md](seasonal-reset-design.md)
2. Load defender's total defense power (sum of unit defense values + system `defense_rating`)
3. Run combat rounds using Soroban `Prng` (seeded per ledger — verifiable, not manipulable):
   - Each round both sides roll
   - Losing side of the round loses units proportional to damage dealt
4. Repeat until one side has no units remaining, or max rounds (20) reached
5. Winner is determined:
   - **Attacker wins** → `galaxy-map.transfer_ownership` is called, attacker takes the system
   - **Defender wins** → system stays, attacker fleet is reduced
6. Battle record is written to contract storage and emitted as a `battle_resolved` event

**Why on-chain randomness?** Soroban's `Prng` is seeded by the ledger sequence + contract address. Outcomes are deterministic given the same inputs and independently verifiable. Players cannot game the randomness by timing their transactions.

---

## Winning

There is no hard win condition — the galaxy is persistent. Players compete for:

- **Most systems owned** — tracked on the leaderboard
- **Most battles won** — tracked per player
- **Resource dominance** — players with high-yield systems accumulate resources faster

## System Upgrades

System upgrades improve defense rather than changing the resource economy. A
system owner may upgrade their claimed system one level at a time by calling
`resources.upgrade_system`; the resources contract verifies ownership and burns
the required Plasma before calling `galaxy-map.upgrade_system`.

The cost is `100 × next_level` PLSM (100 for level 1, 200 for level 2, and so
on). The upgrade is immediate and atomic: if the Plasma burn or ownership check
fails, the level does not change. Each level adds 5 points to the system's
defense during battle; it does not increase `resource_yield`, alter ownership,
or change fleet attack values. `upgrade_level` starts at 0 for newly
initialized systems.

This first version intentionally has no time lock or level cap. The escalating
cost is the economic brake, while a future governance proposal can add a cap or
change the defense curve without changing the stored field.

---

## Future Mechanics (open for contributors)

- **Alliance system** — players form alliances, share system defense
- **System upgrades** — the defense upgrade design above is implemented; future
  proposals may add yield upgrades as a separate, explicitly priced path
- **Fleet specializations** — unit type bonuses against specific enemies
- **Seasonal resets** — optional governance-triggered galaxy resets (proposal: [seasonal-reset-design.md](seasonal-reset-design.md))
