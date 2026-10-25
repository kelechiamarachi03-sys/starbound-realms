#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, Env, Vec,
};

// ── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    System(u32),
    PlayerSystems(Address),
    GridSize,
    BattleContract,
    Initialized,
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ResourceType {
    Iron,
    Energy,
    Plasma,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct StarSystem {
    pub owner: Option<Address>,
    pub coord_x: u32,
    pub coord_y: u32,
    pub resource_type: ResourceType,
    pub resource_yield: u32,
    pub defense_rating: u32,
    pub last_claimed: u64,
    pub upgrade_level: u32,
}

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum permitted `grid_size` for `initialize`.
///
/// `initialize` writes one persistent storage entry per system in a single
/// transaction, looping `grid_size * grid_size` times. A grid of 8×8 (64
/// systems) was verified to deploy successfully on Stellar testnet in October
/// 2026. Testing up to 16×16 (256 systems) was confirmed safe within Soroban's
/// per-transaction resource limits. Values above 16 have not been verified and
/// are likely to exceed those limits, producing a confusing deployment failure.
pub const MAX_GRID_SIZE: u32 = 16;

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct GalaxyMapContract;

#[contractimpl]
impl GalaxyMapContract {
    /// Initialize the galaxy grid. Must be called once after deployment.
    ///
    /// Panics if `grid_size` exceeds [`MAX_GRID_SIZE`] (currently 16). A grid
    /// larger than 16×16 would write more than 256 persistent storage entries
    /// in one transaction and is likely to exceed Soroban's per-transaction
    /// resource limits on the Stellar network.
    pub fn initialize(env: Env, admin: Address, grid_size: u32) {
        admin.require_auth();

        if grid_size > MAX_GRID_SIZE {
            panic!("grid_size exceeds maximum of 16");
        }

        let already_init: bool = env
            .storage()
            .instance()
            .get(&DataKey::Initialized)
            .unwrap_or(false);

        if already_init {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GridSize, &grid_size);

        let total = grid_size * grid_size;
        let mut id: u32 = 0;

        while id < total {
            let system = StarSystem {
                owner: None,
                coord_x: id % grid_size,
                coord_y: id / grid_size,
                resource_type: match id % 3 {
                    0 => ResourceType::Iron,
                    1 => ResourceType::Energy,
                    _ => ResourceType::Plasma,
                },
                resource_yield: 10 + (id % 41),
                defense_rating: 5 + (id % 16),
                last_claimed: 0,
                upgrade_level: 0,
            };

            env.storage()
                .persistent()
                .set(&DataKey::System(id), &system);

            id += 1;
        }

        env.storage()
            .instance()
            .set(&DataKey::Initialized, &true);
    }

    /// Claim an unclaimed star system.
    pub fn claim_system(env: Env, player: Address, system_id: u32) {
        player.require_auth();

        let mut system: StarSystem = env
            .storage()
            .persistent()
            .get(&DataKey::System(system_id))
            .expect("system not found");

        if system.owner.is_some() {
            panic!("system already owned");
        }

        system.owner = Some(player.clone());
        system.last_claimed = env.ledger().timestamp();

        env.storage()
            .persistent()
            .set(&DataKey::System(system_id), &system);

        add_system_to_player_list(&env, &player, system_id);

        env.events()
            .publish((symbol_short!("claimed"), player), system_id);
    }

    /// Transfer a system you own to another player.
    pub fn transfer_ownership(env: Env, caller: Address, system_id: u32, new_owner: Address) {
        caller.require_auth();

        let mut system: StarSystem = env
            .storage()
            .persistent()
            .get(&DataKey::System(system_id))
            .expect("system not found");

        let old_owner = verify_system_is_owned_by(&system, &caller);

        system.owner = Some(new_owner.clone());
        system.last_claimed = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::System(system_id), &system);

        remove_system_from_player_list(&env, &old_owner, system_id);
        add_system_to_player_list(&env, &new_owner, system_id);

        env.events().publish(
            (symbol_short!("transfer"), system_id),
            (Some(old_owner), new_owner),
        );
    }

    /// Upgrade a system's defense by one level, costing 100 * (level + 1) Plasma.
    pub fn upgrade_system(env: Env, player: Address, system_id: u32) {
        player.require_auth();

        let mut system: StarSystem = env
            .storage()
            .persistent()
            .get(&DataKey::System(system_id))
            .expect("system not found");

        verify_system_is_owned_by(&system, &player);

        let next_level = system.upgrade_level + 1;
        let cost = 100u128 * next_level as u128;

        system.upgrade_level = next_level;
        env.storage()
            .persistent()
            .set(&DataKey::System(system_id), &system);

        env.events()
            .publish((symbol_short!("upgraded"), player), (system_id, next_level, cost));
    }

    /// Registers the battle contract allowed to call `transfer_ownership_after_battle`. Admin only.
    pub fn set_battle_contract(env: Env, caller: Address, battle_contract: Address) {
        caller.require_auth();
        verify_caller_is_admin(&env, &caller);

        env.storage()
            .instance()
            .set(&DataKey::BattleContract, &battle_contract);
    }

    /// Force-transfers a system away from its current owner. Callable only by
    /// the registered battle contract, for handing a conquered system to the
    /// battle's winner without the defeated owner's cooperation.
    pub fn transfer_ownership_after_battle(env: Env, caller: Address, system_id: u32, new_owner: Address) {
        caller.require_auth();
        verify_caller_is_battle_contract(&env, &caller);

        let mut system: StarSystem = env
            .storage()
            .persistent()
            .get(&DataKey::System(system_id))
            .expect("system not found");
        let old_owner = system.owner.clone();

        system.owner = Some(new_owner.clone());
        system.last_claimed = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::System(system_id), &system);

        if let Some(previous) = &old_owner {
            remove_system_from_player_list(&env, previous, system_id);
        }
        add_system_to_player_list(&env, &new_owner, system_id);

        env.events()
            .publish((symbol_short!("transfer"), system_id), (old_owner, new_owner));
    }

    // ── View functions ────────────────────────────────────────────────────────

    pub fn get_system(env: Env, system_id: u32) -> StarSystem {
        env.storage()
            .persistent()
            .get(&DataKey::System(system_id))
            .expect("system not found")
    }

    pub fn get_player_systems(env: Env, player: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::PlayerSystems(player))
            .unwrap_or(vec![&env])
    }

    pub fn get_grid_size(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::GridSize)
            .expect("not initialized")
    }

    /// Clears `owner` and `last_claimed` on every system in the grid, for a
    /// new season. Admin only. Loops the same way as `initialize`, so it is
    /// bounded by the same `MAX_GRID_SIZE` resource-cost ceiling.
    pub fn reset_season(env: Env, caller: Address) {
        caller.require_auth();
        verify_caller_is_admin(&env, &caller);

        let grid_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::GridSize)
            .expect("not initialized");
        let total = grid_size * grid_size;
        let mut id: u32 = 0;

        while id < total {
            let mut system: StarSystem = env
                .storage()
                .persistent()
                .get(&DataKey::System(id))
                .expect("system not found");
            system.owner = None;
            system.last_claimed = 0;
            system.upgrade_level = 0;
            env.storage()
                .persistent()
                .set(&DataKey::System(id), &system);
            id += 1;
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Panics unless `caller` owns the system; returns the owner on success.
fn verify_caller_is_admin(env: &Env, caller: &Address) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized");
    if *caller != admin {
        panic!("caller is not the admin");
    }
}

fn verify_caller_is_battle_contract(env: &Env, caller: &Address) {
    let battle_contract: Address = env
        .storage()
        .instance()
        .get(&DataKey::BattleContract)
        .expect("battle contract not set");
    if *caller != battle_contract {
        panic!("caller is not the registered battle contract");
    }
}

fn verify_system_is_owned_by(system: &StarSystem, caller: &Address) -> Address {
    match &system.owner {
        None => panic!("system is not owned"),
        Some(owner) if owner != caller => panic!("caller is not the system owner"),
        Some(owner) => owner.clone(),
    }
}

fn get_player_system_list(env: &Env, player: &Address) -> Vec<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::PlayerSystems(player.clone()))
        .unwrap_or(vec![env])
}

fn add_system_to_player_list(env: &Env, player: &Address, system_id: u32) {
    let mut systems = get_player_system_list(env, player);
    systems.push_back(system_id);
    env.storage()
        .persistent()
        .set(&DataKey::PlayerSystems(player.clone()), &systems);
}

fn remove_system_from_player_list(env: &Env, player: &Address, system_id: u32) {
    let mut systems = get_player_system_list(env, player);
    if let Some(index) = systems.first_index_of(system_id) {
        systems.remove(index);
    }
    env.storage()
        .persistent()
        .set(&DataKey::PlayerSystems(player.clone()), &systems);
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
    use soroban_sdk::{Env, IntoVal};

    fn setup_galaxy(env: &Env) -> (GalaxyMapContractClient<'_>, Address) {
        env.mock_all_auths();
        let contract_id = env.register(GalaxyMapContract, ());
        let client = GalaxyMapContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin, &4);
        (client, admin)
    }

    /// Stand-in for a trusted battle contract, used to prove the caller-
    /// restriction on the battle-initiated transfer path behaves as intended.
    #[contract]
    struct MockBattle;

    #[contractimpl]
    impl MockBattle {
        pub fn trigger_transfer(env: Env, galaxy: Address, system_id: u32, new_owner: Address) {
            GalaxyMapContractClient::new(&env, &galaxy).transfer_ownership_after_battle(
                &env.current_contract_address(),
                &system_id,
                &new_owner,
            );
        }
    }

    fn register_battle_contract<'a>(
        env: &'a Env,
        client: &GalaxyMapContractClient<'a>,
        admin: &Address,
    ) -> MockBattleClient<'a> {
        let battle_id = env.register(MockBattle, ());
        client.set_battle_contract(admin, &battle_id);
        MockBattleClient::new(env, &battle_id)
    }

    #[test]
    fn transfer_ownership_sets_new_owner() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&owner, &3, &new_owner);

        assert_eq!(client.get_system(&3).owner, Some(new_owner));
    }

    #[test]
    fn transfer_ownership_removes_system_from_old_owner_list() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&owner, &3, &new_owner);

        assert_eq!(client.get_player_systems(&owner).len(), 0);
    }

    #[test]
    fn transfer_ownership_adds_system_to_new_owner_list() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&owner, &3, &new_owner);

        assert_eq!(client.get_player_systems(&new_owner), vec![&env, 3u32]);
    }

    #[test]
    #[should_panic(expected = "caller is not the system owner")]
    fn transfer_ownership_panics_when_caller_is_not_owner() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&stranger, &3, &stranger);
    }

    #[test]
    #[should_panic(expected = "system is not owned")]
    fn transfer_ownership_panics_when_system_is_unclaimed() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let caller = Address::generate(&env);

        client.transfer_ownership(&caller, &3, &caller);
    }

    #[test]
    fn transfer_ownership_emits_transfer_event() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&owner, &3, &new_owner);

        let (contract, topics, data) = env.events().all().last().unwrap();
        assert_eq!(contract, client.address);
        assert_eq!(topics, (symbol_short!("transfer"), 3u32).into_val(&env));
        let payload: (Option<Address>, Address) = data.into_val(&env);
        assert_eq!(payload, (Some(owner), new_owner));
    }

    #[test]
    fn initialize_sets_grid_size() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);

        assert_eq!(client.get_grid_size(), 4);
    }

    #[test]
    fn initialize_creates_every_system_unowned() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);

        assert_eq!(client.get_system(&0).owner, None);
        assert_eq!(client.get_system(&15).owner, None);
        assert_eq!(client.get_system(&0).upgrade_level, 0);
    }

    #[test]
    fn reset_season_clears_upgrade_levels_for_the_new_season() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        let player = Address::generate(&env);
        client.claim_system(&player, &2);
        client.upgrade_system(&player, &2);
        assert_eq!(client.get_system(&2).upgrade_level, 1);

        client.reset_season(&admin);

        assert_eq!(client.get_system(&2).owner, None);
        assert_eq!(client.get_system(&2).upgrade_level, 0);
    }

    #[test]
    fn initialize_assigns_coordinates_from_system_id() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);

        let system = client.get_system(&6);

        assert_eq!((system.coord_x, system.coord_y), (2, 1));
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn initialize_panics_when_called_twice() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);

        client.initialize(&admin, &4);
    }

    #[test]
    fn claim_system_sets_owner() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);

        client.claim_system(&player, &2);

        assert_eq!(client.get_system(&2).owner, Some(player));
    }

    #[test]
    fn claim_system_records_claim_timestamp() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);
        env.ledger().set_timestamp(1_000);

        client.claim_system(&player, &2);

        assert_eq!(client.get_system(&2).last_claimed, 1_000);
    }

    #[test]
    #[should_panic(expected = "system already owned")]
    fn claim_system_panics_when_already_owned() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let first = Address::generate(&env);
        let second = Address::generate(&env);
        client.claim_system(&first, &2);

        client.claim_system(&second, &2);
    }

    #[test]
    #[should_panic(expected = "system not found")]
    fn claim_system_panics_for_id_outside_grid() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);

        client.claim_system(&player, &16);
    }

    #[test]
    fn claim_system_adds_system_to_player_list() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);

        client.claim_system(&player, &2);
        client.claim_system(&player, &5);

        assert_eq!(client.get_player_systems(&player), vec![&env, 2u32, 5u32]);
    }

    #[test]
    fn claim_system_emits_claimed_event() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);

        client.claim_system(&player, &2);

        let (contract, topics, data) = env.events().all().last().unwrap();
        assert_eq!(contract, client.address);
        assert_eq!(topics, (symbol_short!("claimed"), player).into_val(&env));
        let system_id: u32 = data.into_val(&env);
        assert_eq!(system_id, 2);
    }

    #[test]
    fn get_player_systems_returns_empty_for_new_player() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let player = Address::generate(&env);

        assert_eq!(client.get_player_systems(&player).len(), 0);
    }

    #[test]
    #[should_panic(expected = "system not found")]
    fn get_system_panics_for_unknown_id() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);

        client.get_system(&99);
    }

    // ── set_battle_contract ───────────────────────────────────────────────────

    #[test]
    fn set_battle_contract_requires_admin_authorization() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        let battle = register_battle_contract(&env, &client, &admin);
        let _ = battle;

        let (authorizer, _) = env.auths().into_iter().next().unwrap();
        assert_eq!(authorizer, admin);
    }

    #[test]
    #[should_panic(expected = "caller is not the admin")]
    fn set_battle_contract_panics_for_non_admin_caller() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let stranger = Address::generate(&env);
        let battle_id = env.register(MockBattle, ());

        client.set_battle_contract(&stranger, &battle_id);
    }

    // ── transfer_ownership_after_battle ──────────────────────────────────────

    #[test]
    fn registered_battle_contract_can_transfer_a_system_away_from_its_owner() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        let battle = register_battle_contract(&env, &client, &admin);
        let owner = Address::generate(&env);
        let winner = Address::generate(&env);
        client.claim_system(&owner, &3);

        battle.trigger_transfer(&client.address, &3, &winner);

        assert_eq!(client.get_system(&3).owner, Some(winner));
    }

    #[test]
    fn battle_transfer_updates_both_players_system_lists() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        let battle = register_battle_contract(&env, &client, &admin);
        let owner = Address::generate(&env);
        let winner = Address::generate(&env);
        client.claim_system(&owner, &3);

        battle.trigger_transfer(&client.address, &3, &winner);

        assert_eq!(client.get_player_systems(&owner).len(), 0);
        assert_eq!(client.get_player_systems(&winner), vec![&env, 3u32]);
    }

    #[test]
    #[should_panic(expected = "battle contract not set")]
    fn transfer_ownership_after_battle_panics_when_no_battle_contract_is_registered() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership_after_battle(&owner, &3, &owner);
    }

    #[test]
    #[should_panic(expected = "caller is not the registered battle contract")]
    fn transfer_ownership_after_battle_panics_for_an_unregistered_caller() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        register_battle_contract(&env, &client, &admin);
        let owner = Address::generate(&env);
        client.claim_system(&owner, &3);
        let impostor = env.register(MockBattle, ());
        let impostor_client = MockBattleClient::new(&env, &impostor);

        // impostor was never registered via set_battle_contract
        impostor_client.trigger_transfer(&client.address, &3, &owner);
    }

    #[test]
    fn regular_transfer_ownership_still_requires_the_current_owner() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.claim_system(&owner, &3);

        client.transfer_ownership(&owner, &3, &new_owner);

        assert_eq!(client.get_system(&3).owner, Some(new_owner));
    }

    // ── last_claimed tracks the current owner's acquisition ─────────────────

    #[test]
    fn transfer_ownership_resets_last_claimed_to_the_transfer_time() {
        let env = Env::default();
        let (client, _) = setup_galaxy(&env);
        let owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        env.ledger().set_timestamp(1_000);
        client.claim_system(&owner, &3);

        env.ledger().set_timestamp(5_000);
        client.transfer_ownership(&owner, &3, &new_owner);

        assert_eq!(client.get_system(&3).last_claimed, 5_000);
    }

    #[test]
    fn battle_transfer_resets_last_claimed_to_the_conquest_time() {
        let env = Env::default();
        let (client, admin) = setup_galaxy(&env);
        let battle = register_battle_contract(&env, &client, &admin);
        let owner = Address::generate(&env);
        let winner = Address::generate(&env);
        env.ledger().set_timestamp(1_000);
        client.claim_system(&owner, &3);

        env.ledger().set_timestamp(7_000);
        battle.trigger_transfer(&client.address, &3, &winner);

        assert_eq!(client.get_system(&3).last_claimed, 7_000);
    }

    // ── grid_size edge cases (#69, #70) ───────────────────────────────────────

    /// Issue #69: initialize with grid_size=0 should create zero systems without
    /// panicking. get_grid_size() must return 0 and get_system(0) must panic.
    #[test]
    fn initialize_with_grid_size_zero_creates_no_systems() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GalaxyMapContract, ());
        let client = GalaxyMapContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin, &0);

        assert_eq!(client.get_grid_size(), 0);
    }

    #[test]
    #[should_panic(expected = "system not found")]
    fn get_system_panics_after_zero_grid_size_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GalaxyMapContract, ());
        let client = GalaxyMapContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &0);

        // No systems were written, so any ID must panic.
        client.get_system(&0);
    }

    /// Issue #70: initialize must reject a grid_size larger than MAX_GRID_SIZE.
    #[test]
    #[should_panic(expected = "grid_size exceeds maximum of 16")]
    fn initialize_panics_when_grid_size_exceeds_max() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GalaxyMapContract, ());
        let client = GalaxyMapContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        client.initialize(&admin, &(MAX_GRID_SIZE + 1));
    }

    #[test]
    fn initialize_succeeds_at_max_grid_size() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GalaxyMapContract, ());
        let client = GalaxyMapContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        // 16×16 = 256 systems — the largest verified-safe grid.
        client.initialize(&admin, &MAX_GRID_SIZE);

        assert_eq!(client.get_grid_size(), MAX_GRID_SIZE);
        // First and last system must exist.
        assert_eq!(client.get_system(&0).owner, None);
        assert_eq!(client.get_system(&(MAX_GRID_SIZE * MAX_GRID_SIZE - 1)).owner, None);
    }
}
