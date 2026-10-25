import { StarboundClient, StarboundClientConfig } from '@starbound-realms/sdk';

const REQUIRED_KEYS = [
  'VITE_SOROBAN_RPC_URL',
  'VITE_NETWORK_PASSPHRASE',
  'VITE_CONTRACT_GALAXY_MAP',
  'VITE_CONTRACT_RESOURCES',
  'VITE_CONTRACT_FLEET',
  'VITE_CONTRACT_BATTLE',
  'VITE_CONTRACT_ALLIANCE',
] as const;

/** Reads one required env var, or throws a clear error naming which one is missing. */
function requireEnv(env: Record<string, string | undefined>, key: (typeof REQUIRED_KEYS)[number] | 'VITE_RESOURCE_ISSUER'): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

/** Maps raw VITE_ env vars to a StarboundClientConfig, validating all are present. */
export function buildStarboundClientConfig(env: Record<string, string | undefined>): StarboundClientConfig {
  return {
    rpcUrl: requireEnv(env, 'VITE_SOROBAN_RPC_URL'),
    networkPassphrase: requireEnv(env, 'VITE_NETWORK_PASSPHRASE'),
    contractIds: {
      galaxyMap: requireEnv(env, 'VITE_CONTRACT_GALAXY_MAP'),
      resources: requireEnv(env, 'VITE_CONTRACT_RESOURCES'),
      fleet: requireEnv(env, 'VITE_CONTRACT_FLEET'),
      battle: requireEnv(env, 'VITE_CONTRACT_BATTLE'),
      alliance: requireEnv(env, 'VITE_CONTRACT_ALLIANCE'),
    },
  };
}

let cachedClient: StarboundClient | null = null;

/** Returns a shared StarboundClient instance, built from Vite's env vars on first use. */
export function getStarboundClient(): StarboundClient {
  if (!cachedClient) {
    cachedClient = new StarboundClient(buildStarboundClientConfig(import.meta.env));
  }
  return cachedClient;
}

/** Reads the address that issued the IRON/NRGY/PLSM assets, which trustlines must name. */
export function readResourceIssuer(env: Record<string, string | undefined>): string {
  return requireEnv(env, 'VITE_RESOURCE_ISSUER');
}

/** Returns the resource asset issuer from Vite's env vars. */
export function getResourceIssuer(): string {
  return readResourceIssuer(import.meta.env);
}

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

export type NetworkLabel = 'Testnet' | 'Mainnet' | 'Unknown network';

/** Maps a Stellar network passphrase to a human-readable network label. */
export function getNetworkLabel(passphrase: string | undefined): NetworkLabel {
  if (passphrase === MAINNET_PASSPHRASE) {
    return 'Mainnet';
  }
  if (passphrase === TESTNET_PASSPHRASE) {
    return 'Testnet';
  }
  return 'Unknown network';
}

/** Returns the label for the network configured via Vite's env vars. */
export function getConfiguredNetworkLabel(): NetworkLabel {
  return getNetworkLabel(import.meta.env.VITE_NETWORK_PASSPHRASE);
}
