import { describe, it, expect, vi } from 'vitest';
import { nativeToScVal, rpc, xdr, StrKey } from '@stellar/stellar-sdk';
import { StarboundClient, MIN_STELLAR_SDK_VERSION, assertCompatibleStellarSdk } from './client.js';
import { SimulationError, NetworkError } from './errors.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));

describe('assertCompatibleStellarSdk', () => {
  it('succeeds with the installed @stellar/stellar-sdk (>=17.2.1)', () => {
    expect(MIN_STELLAR_SDK_VERSION).toBe('17.2.1');
    expect(() => assertCompatibleStellarSdk()).not.toThrow();
  });

  it('throws a descriptive error referencing Bad union switch: 4 when xdr.TransactionMeta.v4 is missing (e.g. v13)', () => {
    expect(() => assertCompatibleStellarSdk({ TransactionMeta: {} })).toThrow(/TransactionMeta\.v4/);
    expect(() => assertCompatibleStellarSdk({ TransactionMeta: {} })).toThrow(/Bad union switch: 4/);
  });
});

function makeClient(server: Partial<rpc.Server>): StarboundClient {
  const client = new StarboundClient({
    rpcUrl: 'https://example.invalid',
    networkPassphrase: 'Test SDF Network ; September 2015',
    contractIds: { galaxyMap: CONTRACT_ID, resources: CONTRACT_ID, fleet: CONTRACT_ID, battle: CONTRACT_ID, alliance: CONTRACT_ID },
  });
  (client as any).server = server;
  return client;
}

function successResponse(retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {} as any,
    minResourceFee: '100',
    result: { auth: [], retval },
  };
}

function errorResponse(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error };
}

describe('simulateReadCall', () => {
  it('returns the decoded native value on a successful simulation', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(successResponse(nativeToScVal(4, { type: 'u32' })));
    const client = makeClient({ simulateTransaction });

    const result = await client.simulateReadCall(CONTRACT_ID, 'get_grid_size');

    expect(result).toBe(4);
  });

  it('passes the given arguments through to the contract call', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(successResponse(nativeToScVal(0, { type: 'u32' })));
    const client = makeClient({ simulateTransaction });

    await client.simulateReadCall(CONTRACT_ID, 'get_system', [nativeToScVal(3, { type: 'u32' })]);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    const tx = simulateTransaction.mock.calls[0][0];
    expect(typeof tx.toXDR).toBe('function');
  });

  it('throws a SimulationError when the simulation fails', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(errorResponse('system not found'));
    const client = makeClient({ simulateTransaction });

    await expect(client.simulateReadCall(CONTRACT_ID, 'get_system')).rejects.toThrow('system not found');
  });

  it('throws a SimulationError (instanceof) on simulation failure', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(errorResponse('contract panicked'));
    const client = makeClient({ simulateTransaction });

    await expect(client.simulateReadCall(CONTRACT_ID, 'get_system')).rejects.toBeInstanceOf(SimulationError);
  });

  // ── Retry behaviour (issue #61) ──────────────────────────────────────────

  it('retries a transient network error and succeeds on second attempt', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const simulateTransaction = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValue(successResponse(nativeToScVal(7, { type: 'u32' })));
    const client = makeClient({ simulateTransaction });

    const result = await client.simulateReadCall(CONTRACT_ID, 'get_grid_size');

    expect(result).toBe(7);
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 attempts then throws NetworkError after repeated transient failures', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const simulateTransaction = vi.fn().mockRejectedValue(transientErr);
    const client = makeClient({ simulateTransaction });

    await expect(client.simulateReadCall(CONTRACT_ID, 'get_grid_size')).rejects.toBeInstanceOf(NetworkError);
    expect(simulateTransaction).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a real simulation error (contract panic)', async () => {
    const simulateTransaction = vi.fn()
      .mockResolvedValue(errorResponse('contract panicked: index out of range'));
    const client = makeClient({ simulateTransaction });

    await expect(client.simulateReadCall(CONTRACT_ID, 'get_system')).rejects.toBeInstanceOf(SimulationError);
    // Only one call — no retry.
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });
});
