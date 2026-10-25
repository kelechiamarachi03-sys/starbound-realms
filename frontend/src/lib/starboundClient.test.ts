import { describe, it, expect } from 'vitest';
import { buildStarboundClientConfig, getNetworkLabel, readResourceIssuer } from './starboundClient';

function validEnv(): Record<string, string | undefined> {
  return {
    VITE_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    VITE_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    VITE_CONTRACT_GALAXY_MAP: 'CGALAXY',
    VITE_CONTRACT_RESOURCES: 'CRESOURCES',
    VITE_CONTRACT_FLEET: 'CFLEET',
    VITE_CONTRACT_BATTLE: 'CBATTLE',
    VITE_CONTRACT_ALLIANCE: 'CALLIANCE',
  };
}

describe('buildStarboundClientConfig', () => {
  it('maps VITE_ env vars to a StarboundClientConfig', () => {
    const config = buildStarboundClientConfig(validEnv());

    expect(config).toEqual({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: {
        galaxyMap: 'CGALAXY',
        resources: 'CRESOURCES',
        fleet: 'CFLEET',
        battle: 'CBATTLE',
        alliance: 'CALLIANCE',
      },
    });
  });

  it('throws when a required var is set to an empty string, not just when absent', () => {
    const env = validEnv();
    env.VITE_CONTRACT_FLEET = '';

    expect(() => buildStarboundClientConfig(env)).toThrow(/VITE_CONTRACT_FLEET/);
  });

  it.each([
    'VITE_SOROBAN_RPC_URL',
    'VITE_NETWORK_PASSPHRASE',
    'VITE_CONTRACT_GALAXY_MAP',
    'VITE_CONTRACT_RESOURCES',
    'VITE_CONTRACT_FLEET',
    'VITE_CONTRACT_BATTLE',
    'VITE_CONTRACT_ALLIANCE',
  ])('throws a clear error when %s is missing', (key) => {
    const env = validEnv();
    delete env[key];

    expect(() => buildStarboundClientConfig(env)).toThrow(new RegExp(key));
  });
});

describe('readResourceIssuer', () => {
  it('returns the issuer address of the resource assets', () => {
    expect(readResourceIssuer({ VITE_RESOURCE_ISSUER: 'GISSUER' })).toBe('GISSUER');
  });

  it('throws a clear error when it is missing', () => {
    expect(() => readResourceIssuer({})).toThrow(/VITE_RESOURCE_ISSUER/);
  });

  it('throws when it is set to an empty string', () => {
    expect(() => readResourceIssuer({ VITE_RESOURCE_ISSUER: '' })).toThrow(/VITE_RESOURCE_ISSUER/);
  });
});

describe('getNetworkLabel', () => {
  it('labels the testnet passphrase as Testnet', () => {
    expect(getNetworkLabel('Test SDF Network ; September 2015')).toBe('Testnet');
  });

  it('labels the public passphrase as Mainnet', () => {
    expect(getNetworkLabel('Public Global Stellar Network ; September 2015')).toBe('Mainnet');
  });

  it('labels any other or missing passphrase as an unknown network', () => {
    expect(getNetworkLabel('Standalone Network ; February 2017')).toBe('Unknown network');
    expect(getNetworkLabel(undefined)).toBe('Unknown network');
  });
});
