import { describe, it, expect, vi } from 'vitest';
import {
  Account,
  Asset,
  BASE_FEE,
  Operation,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import { StarboundClient } from './client.js';
import { TransactionRejectedError, TransactionFailedError, NetworkError } from './errors.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 5));
const SOURCE = Keypair.random().publicKey();

function makeClient(server: Partial<rpc.Server>): StarboundClient {
  const client = new StarboundClient({
    rpcUrl: 'https://example.invalid',
    networkPassphrase: Networks.TESTNET,
    contractIds: { galaxyMap: CONTRACT_ID, resources: CONTRACT_ID, fleet: CONTRACT_ID, battle: CONTRACT_ID, alliance: CONTRACT_ID },
  });
  (client as any).server = server;
  return client;
}

/** A real, validly-encoded transaction, the way server.prepareTransaction would return one. */
function buildRealTransaction() {
  const account = new Account(SOURCE, '10');
  const contract = new Contract(CONTRACT_ID);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call('claim_system'))
    .setTimeout(30)
    .build();
}

function baseServer(overrides: Partial<rpc.Server> = {}): Partial<rpc.Server> {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(SOURCE, '10')),
    prepareTransaction: vi.fn().mockResolvedValue(buildRealTransaction()),
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'HASH1', latestLedger: 1 }),
    pollTransaction: vi.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: 'HASH1' }),
    ...overrides,
  };
}

function realSigner(): (xdr: string) => Promise<string> {
  const signerKey = Keypair.random();
  return async (unsignedXdr: string) => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    tx.sign(signerKey);
    return tx.toXDR();
  };
}

describe('submitTransaction', () => {
  it('sends the actual signed transaction, not the original unsigned one', async () => {
    const server = baseServer();
    const client = makeClient(server);

    await client.submitTransaction({
      sourceAddress: SOURCE,
      operation: new Contract(CONTRACT_ID).call('claim_system'),
      sign: realSigner(),
    });

    const sentTx = (server.sendTransaction as any).mock.calls[0][0];
    expect(sentTx.signatures.length).toBeGreaterThan(0);
  });

  it('signs the prepared transaction using the given signer and submits it', async () => {
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);
    const client = makeClient(baseServer());

    await client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(typeof sign.mock.calls[0][0]).toBe('string');
  });

  it('returns the successful transaction result after polling', async () => {
    const server = baseServer();
    const client = makeClient(server);
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);

    const result = await client.submitTransaction({
      sourceAddress: SOURCE,
      operation: new Contract(CONTRACT_ID).call('claim_system'),
      sign,
    });

    expect(result.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
    expect((server.pollTransaction as any)).toHaveBeenCalledWith('HASH1');
  });

  it('throws TransactionRejectedError (instanceof) when the network rejects the transaction', async () => {
    const server = baseServer({
      sendTransaction: vi.fn().mockResolvedValue({ status: 'ERROR', hash: 'HASH1', latestLedger: 1 }),
    });
    const client = makeClient(server);
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);

    await expect(
      client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign })
    ).rejects.toBeInstanceOf(TransactionRejectedError);
  });

  it('throws a clear error matching /rejected/ when the network rejects the transaction', async () => {
    const server = baseServer({
      sendTransaction: vi.fn().mockResolvedValue({ status: 'ERROR', hash: 'HASH1', latestLedger: 1 }),
    });
    const client = makeClient(server);
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);

    await expect(
      client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign })
    ).rejects.toThrow(/rejected/i);
  });

  it('throws TransactionFailedError (instanceof) when the transaction fails on-chain', async () => {
    const server = baseServer({
      pollTransaction: vi.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.FAILED, txHash: 'HASH1' }),
    });
    const client = makeClient(server);
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);

    await expect(
      client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign })
    ).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it('throws a clear error matching /failed/ when the transaction fails on-chain', async () => {
    const server = baseServer({
      pollTransaction: vi.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.FAILED, txHash: 'HASH1' }),
    });
    const client = makeClient(server);
    const sign = vi.fn().mockImplementation(async (xdr: string) => xdr);

    await expect(
      client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign })
    ).rejects.toThrow(/failed/i);
  });

  // ── Retry on the write path (issue #62) ─────────────────────────────────

  it('retries a transient network error on getAccount and succeeds', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const server = baseServer({
      getAccount: vi.fn()
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValue(new Account(SOURCE, '10')),
    });
    const client = makeClient(server);

    await client.submitTransaction({
      sourceAddress: SOURCE,
      operation: new Contract(CONTRACT_ID).call('claim_system'),
      sign: realSigner(),
    });

    expect((server.getAccount as any)).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error on prepareTransaction and succeeds', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const server = baseServer({
      prepareTransaction: vi.fn()
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValue(buildRealTransaction()),
    });
    const client = makeClient(server);

    await client.submitTransaction({
      sourceAddress: SOURCE,
      operation: new Contract(CONTRACT_ID).call('claim_system'),
      sign: realSigner(),
    });

    expect((server.prepareTransaction as any)).toHaveBeenCalledTimes(2);
  });

  it('throws NetworkError after repeated transient failures on getAccount', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const server = baseServer({
      getAccount: vi.fn().mockRejectedValue(transientErr),
    });
    const client = makeClient(server);
    const sign = vi.fn();

    await expect(
      client.submitTransaction({ sourceAddress: SOURCE, operation: new Contract(CONTRACT_ID).call('claim_system'), sign })
    ).rejects.toBeInstanceOf(NetworkError);
    expect((server.getAccount as any)).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry sendTransaction', async () => {
    // sendTransaction failure should propagate without retry.
    const server = baseServer({
      sendTransaction: vi.fn().mockResolvedValue({ status: 'TRY_AGAIN_LATER', hash: 'HASH1', latestLedger: 1 }),
    });
    const client = makeClient(server);

    await expect(
      client.submitTransaction({
        sourceAddress: SOURCE,
        operation: new Contract(CONTRACT_ID).call('claim_system'),
        sign: realSigner(),
      })
    ).rejects.toBeInstanceOf(TransactionRejectedError);
    // Exactly one attempt.
    expect((server.sendTransaction as any)).toHaveBeenCalledTimes(1);
  });
});

describe('submitClassicTransaction', () => {
  const ISSUER = Keypair.random().publicKey();
  const trustOps = () => ['IRON', 'NRGY'].map((code) => Operation.changeTrust({ asset: new Asset(code, ISSUER) }));

  it('never calls prepareTransaction, since RPC simulation rejects classic operations', async () => {
    const server = baseServer();
    const client = makeClient(server);

    await client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() });

    expect(server.prepareTransaction).not.toHaveBeenCalled();
  });

  it('puts every given operation into one signed transaction', async () => {
    const server = baseServer();
    const client = makeClient(server);

    await client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() });

    const sentTx = (server.sendTransaction as any).mock.calls[0][0];
    expect(sentTx.operations.map((op: any) => op.type)).toEqual(['changeTrust', 'changeTrust']);
    expect(sentTx.signatures.length).toBeGreaterThan(0);
  });

  it('throws TransactionRejectedError (instanceof) when the network rejects the transaction', async () => {
    const server = baseServer({
      sendTransaction: vi.fn().mockResolvedValue({ status: 'ERROR', hash: 'HASH1', latestLedger: 1 }),
    });
    const client = makeClient(server);

    await expect(
      client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() })
    ).rejects.toBeInstanceOf(TransactionRejectedError);
  });

  it('throws a clear error matching /rejected/ when the network rejects the transaction', async () => {
    const server = baseServer({
      sendTransaction: vi.fn().mockResolvedValue({ status: 'ERROR', hash: 'HASH1', latestLedger: 1 }),
    });
    const client = makeClient(server);

    await expect(
      client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() })
    ).rejects.toThrow(/rejected/i);
  });

  it('throws TransactionFailedError (instanceof) when the transaction fails on-chain', async () => {
    const server = baseServer({
      pollTransaction: vi.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.FAILED, txHash: 'HASH1' }),
    });
    const client = makeClient(server);

    await expect(
      client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() })
    ).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it('throws a clear error matching /failed/ when the transaction fails on-chain', async () => {
    const server = baseServer({
      pollTransaction: vi.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.FAILED, txHash: 'HASH1' }),
    });
    const client = makeClient(server);

    await expect(
      client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() })
    ).rejects.toThrow(/failed/i);
  });

  // ── Retry on the classic write path (issue #62) ──────────────────────────

  it('retries a transient network error on getAccount in submitClassicTransaction', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const server = baseServer({
      getAccount: vi.fn()
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValue(new Account(SOURCE, '10')),
    });
    const client = makeClient(server);

    await client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() });

    expect((server.getAccount as any)).toHaveBeenCalledTimes(2);
  });

  it('throws NetworkError after repeated transient getAccount failures in classic path', async () => {
    const transientErr = new Error('client error (SendRequest)');
    const server = baseServer({
      getAccount: vi.fn().mockRejectedValue(transientErr),
    });
    const client = makeClient(server);

    await expect(
      client.submitClassicTransaction({ sourceAddress: SOURCE, operations: trustOps(), sign: realSigner() })
    ).rejects.toBeInstanceOf(NetworkError);
    expect((server.getAccount as any)).toHaveBeenCalledTimes(3);
  });
});
