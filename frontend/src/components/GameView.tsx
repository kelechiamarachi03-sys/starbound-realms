import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GalaxyClient, FleetClient, BattleClient, UnitType } from '@starbound-realms/sdk';
import { useGalaxyData } from '../hooks/useGalaxyData';
import { useFleetData } from '../hooks/useFleetData';
import { useResourceBalances } from '../hooks/useResourceBalances';
import { useRecentBattles } from '../hooks/useRecentBattles';
import { useTrustlines } from '../hooks/useTrustlines';
import { usePlayerProfile } from '../hooks/usePlayerProfile';
import { useBattleHistory } from '../hooks/useBattleHistory';
import { GalaxyMap } from './GalaxyMap';
import { StarSystem } from './StarSystem';
import { Fleet } from './Fleet';
import { ResourceBalances } from './ResourceBalances';
import { BattleFeed } from './BattleFeed';
import { PlayerProfile } from './PlayerProfile';
import { BattleLog } from './BattleLog';
import { ResourceSetupBanner } from './ResourceSetupBanner';
import { GalaxyEmptyState } from './GalaxyEmptyState';
import { AlliancePanel } from './AlliancePanel';
import { LoadingIndicator } from './LoadingIndicator';
import { useNotification } from './Notifications';
import { getStarboundClient } from '../lib/starboundClient';
import { readStoredSystemId, storeSystemId, clearStoredSystemId } from '../lib/selectedSystemStorage';

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  galaxySection: {
    maxWidth: '900px',
    width: '100%',
    margin: '3rem auto 0',
    padding: '0 2rem',
  },

  galaxyTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '1rem',
    color: 'var(--text)',
  },

  textMuted: {
    color: 'var(--text-muted)',
    fontSize: '0.9rem',
  },
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GameViewProps {
  walletAddress: string;
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>;
  backendUrl: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Renders the full connected-wallet game UI: galaxy map, star-system drawer,
 * fleet builder, resource balances, and the recent-battles feed.
 *
 * Receives `walletAddress`, `signTransaction`, and `backendUrl` as props so
 * it can be tested in isolation without a real Freighter or Soroban node.
 */
export function GameView({ walletAddress, signTransaction, backendUrl }: GameViewProps) {
  const { systems, isLoading: galaxyLoading, error: galaxyError, refetch: refetchGalaxy } =
    useGalaxyData(backendUrl);

  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(null);
  const selectedSystemTriggerRef = useRef<{ element: SVGRectElement; systemId: number } | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const selectedSystem = systems.find((s) => s.systemId === selectedSystemId) ?? null;

  const selectSystem = useCallback((systemId: number, trigger: SVGRectElement) => {
    selectedSystemTriggerRef.current = { element: trigger, systemId };
    setSelectedSystemId(systemId);
    storeSystemId(systemId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSystemId(null);
    clearStoredSystemId();
  }, []);

  // Restores the last-selected system once the galaxy first loads (#133). Runs
  // only once, so a later refetch never reopens a drawer the player has closed.
  const restoredSelectionRef = useRef(false);
  useEffect(() => {
    if (restoredSelectionRef.current || galaxyLoading || galaxyError) return;
    restoredSelectionRef.current = true;

    const storedId = readStoredSystemId();
    if (storedId === null) return;
    if (systems.some((s) => s.systemId === storedId)) {
      setSelectedSystemId(storedId);
    } else {
      clearStoredSystemId();
    }
  }, [galaxyLoading, galaxyError, systems]);

  useEffect(() => {
    const trigger = selectedSystemTriggerRef.current;
    if (selectedSystemId === null && trigger) {
      const focusTarget = trigger.element.isConnected
        ? trigger.element
        : document.getElementById(`galaxy-cell-${trigger.systemId}`);

      if (focusTarget) {
        focusTarget.focus();
        selectedSystemTriggerRef.current = null;
      }
    }
  }, [galaxyLoading, selectedSystemId]);

  const claimSystem = useCallback(
    async (systemId: number) => {
      setClaimError(null);
      try {
        const client = getStarboundClient();
        const galaxy = new GalaxyClient(client);
        await galaxy.claimSystem(walletAddress, systemId, (xdr) => signTransaction(xdr, client.networkPassphrase));
        await refetchGalaxy();
        clearSelection();
      } catch (err) {
        setClaimError(err instanceof Error ? err.message : String(err));
      }
    },
    [walletAddress, signTransaction, refetchGalaxy, clearSelection]
  );

  const { fleet, isLoading: fleetLoading, error: fleetError, refetch: refetchFleet } =
    useFleetData(walletAddress);
  const { balances, isLoading: balancesLoading, error: balancesError, refetch: refetchBalances } =
    useResourceBalances(walletAddress);
  const { profile, isLoading: profileLoading, error: profileError } = usePlayerProfile(backendUrl, walletAddress);
  const { battles: playerBattles, isLoading: historyLoading, error: historyError } =
    useBattleHistory(backendUrl, walletAddress);
  const playerSectionRef = useRef<HTMLDivElement>(null);
  const recentBattles = useRecentBattles(backendUrl);

  const {
    missing: missingTrustlines,
    isLoading: trustlinesLoading,
    isSettingUp: settingUpTrustlines,
    error: trustlineError,
    setUpTrustlines,
  } = useTrustlines(walletAddress, signTransaction);

  const [buildError, setBuildError] = useState<string | null>(null);

  const buildUnit = useCallback(
    async (unitType: UnitType, count: number) => {
      setBuildError(null);
      try {
        const client = getStarboundClient();
        const fleetClient = new FleetClient(client);
        await fleetClient.buildUnit(walletAddress, unitType, count, (xdr) =>
          signTransaction(xdr, client.networkPassphrase)
        );
        await Promise.all([refetchFleet(), refetchBalances()]);
      } catch (err) {
        setBuildError(err instanceof Error ? err.message : String(err));
      }
    },
    [walletAddress, signTransaction, refetchFleet, refetchBalances]
  );

  const [moveError, setMoveError] = useState<string | null>(null);

  const moveFleet = useCallback(
    async (targetSystemId: number) => {
      setMoveError(null);
      try {
        const client = getStarboundClient();
        const fleetClient = new FleetClient(client);
        await fleetClient.moveFleet(walletAddress, targetSystemId, (xdr) =>
          signTransaction(xdr, client.networkPassphrase)
        );
        await refetchFleet();
        clearSelection();
      } catch (err) {
        setMoveError(err instanceof Error ? err.message : String(err));
      }
    },
    [walletAddress, signTransaction, refetchFleet, clearSelection]
  );

  const [attackError, setAttackError] = useState<string | null>(null);
  const [battleResult, setBattleResult] = useState<string | null>(null);

  const attackSystem = useCallback(
    async (systemId: number) => {
      const defender = systems.find((s) => s.systemId === systemId)?.owner;
      if (!defender) {
        return;
      }
      setAttackError(null);
      setBattleResult(null);
      try {
        const client = getStarboundClient();
        const battleClient = new BattleClient(client);
        const battleId = await battleClient.resolveBattle(walletAddress, defender, systemId, (xdr) =>
          signTransaction(xdr, client.networkPassphrase)
        );
        const battle = await battleClient.getBattle(battleId);
        setBattleResult(
          battle.winner === walletAddress
            ? `Victory! You took system ${systemId} in ${battle.rounds} round(s).`
            : `Defeat. Your fleet was repelled from system ${systemId} after ${battle.rounds} round(s).`
        );
        await Promise.all([refetchFleet(), refetchGalaxy()]);
        clearSelection();
      } catch (err) {
        setAttackError(err instanceof Error ? err.message : String(err));
      }
    },
    [walletAddress, systems, signTransaction, refetchFleet, refetchGalaxy, clearSelection]
  );

  useNotification(trustlineError);
  useNotification(galaxyError);
  useNotification(claimError);
  useNotification(moveError);
  useNotification(attackError);
  useNotification(balancesError);
  useNotification(fleetError);
  useNotification(buildError);

  return (
    <>
      {/* Galaxy map section */}
      <section style={styles.galaxySection}>
        {trustlinesLoading ? (
          <LoadingIndicator label="Checking resource setup…" />
        ) : (
          <ResourceSetupBanner
            missing={missingTrustlines}
            isSettingUp={settingUpTrustlines}
            onSetUp={setUpTrustlines}
          />
        )}
        <h2 style={styles.galaxyTitle}>The Galaxy</h2>
        {galaxyLoading && <LoadingIndicator label="Loading galaxy…" />}
        {!galaxyLoading && !galaxyError && (
          <>
            <GalaxyEmptyState
              ownedCount={systems.filter((s) => s.owner === walletAddress).length}
              claimedCount={systems.filter((s) => s.owner).length}
            />
            <GalaxyMap systems={systems} walletAddress={walletAddress} onSelectSystem={selectSystem} />
            <StarSystem
              system={selectedSystem}
              walletAddress={walletAddress}
              fleet={fleet}
              onClose={clearSelection}
              onClaim={claimSystem}
              onMoveFleet={moveFleet}
              onAttack={attackSystem}
            />
            {battleResult && <p style={styles.textMuted}>{battleResult}</p>}

            <div ref={playerSectionRef}>
              <h2 style={styles.galaxyTitle}>Your Profile</h2>
              <PlayerProfile profile={profile} isLoading={profileLoading} error={profileError} />
              {balancesLoading ? (
                <LoadingIndicator label="Loading resource balances…" />
              ) : (
                <ResourceBalances balances={balances} />
              )}
              {fleetLoading ? (
                <LoadingIndicator label="Loading fleet…" />
              ) : (
                <Fleet fleet={fleet} onBuildUnit={buildUnit} />
              )}
            </div>

            <AlliancePanel walletAddress={walletAddress} signTransaction={signTransaction} />

            <div>
              <h2 style={styles.galaxyTitle}>Battle History</h2>
              <BattleLog
                battles={playerBattles}
                isLoading={historyLoading}
                error={historyError}
                playerAddress={walletAddress}
              />
            </div>
          </>
        )}
      </section>

      {/* Galaxy-wide battle feed */}
      <section style={styles.galaxySection}>
        <h2 style={styles.galaxyTitle}>Recent Battles</h2>
        <BattleFeed
          battles={recentBattles.battles}
          isLoading={recentBattles.isLoading}
          error={recentBattles.error}
          hasPreviousPage={recentBattles.hasPreviousPage}
          hasNextPage={recentBattles.hasNextPage}
          onPreviousPage={recentBattles.goToPreviousPage}
          onNextPage={recentBattles.goToNextPage}
        />
      </section>
    </>
  );
}
