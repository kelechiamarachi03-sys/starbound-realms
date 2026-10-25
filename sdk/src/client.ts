import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  NetworkError,
  SimulationError,
  TransactionFailedError,
  TransactionRejectedError,
  isTransientNetworkError,
} from './errors.js';

/** Signs an unsigned transaction XDR string and returns the signed XDR string. */
export type TransactionSigner = (xdr: string) => Promise<string>;

export interface WriteCallOptions {
  /** The Stellar address that will be the transaction source. */
  sourceAddress: string;
  /** The Soroban contract operation to invoke. */
  operation: xdr.Operation;
  /** A {@link TransactionSigner} that provides the source account's signature. */
  sign: TransactionSigner;
}

export interface ClassicCallOptions {
  /** The Stellar address that will be the transaction source. */
  sourceAddress: string;
  /** One or more classic (non-Soroban) operations to include in the transaction. */
  operations: xdr.Operation[];
  /** A {@link TransactionSigner} that provides the source account's signature. */
  sign: TransactionSigner;
}

export interface ContractIds {
  /** Deployed contract ID for the `galaxy-map` contract. */
  galaxyMap: string;
  /** Deployed contract ID for the `resources` contract. */
  resources: string;
  /** Deployed contract ID for the `fleet` contract. */
  fleet: string;
  /** Deployed contract ID for the `battle` contract. */
  battle: string;
  /** Deployed contract ID for the `alliance` contract. */
  alliance: string;
}

export interface StarboundClientConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase (e.g. `Networks.TESTNET`). */
  networkPassphrase: string;
  /** Deployed contract IDs for each of the four game contracts. */
  contractIds: ContractIds;
}

/**
 * Minimum tested `@stellar/stellar-sdk` version required by `@starbound-realms/sdk`.
 *
 * Versions prior to 17 (e.g. 13.x) lack `xdr.TransactionMeta` v4 support, which
 * Stellar testnet returns since Protocol 23 — causing every write confirmation
 * to throw `'Bad union switch: 4'` after landing on-chain.
 */
export const MIN_STELLAR_SDK_VERSION = '17.2.1';

/**
 * Verifies at runtime that the loaded `@stellar/stellar-sdk` supports
 * Protocol 23+ `TransactionMeta` v4 XDR decoding and v17 plain-data XDR shapes.
 *
 * @param xdrModule - Optional XDR namespace override (used for testing).
 * @throws If the loaded `@stellar/stellar-sdk` lacks `xdr.TransactionMeta.v4`.
 */
export function assertCompatibleStellarSdk(
  xdrModule: { TransactionMeta?: { v4?: unknown } } = xdr as unknown as { TransactionMeta?: { v4?: unknown } }
): void {
  if (typeof xdrModule?.TransactionMeta?.v4 !== 'function') {
    throw new Error(
      `Incompatible @stellar/stellar-sdk: missing xdr.TransactionMeta.v4 (minimum tested version is ${MIN_STELLAR_SDK_VERSION}; v13 throws "Bad union switch: 4" on Protocol 23+ transaction confirmations)`
    );
  }
}

export interface RetryOptions {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Base delay in milliseconds between attempts, doubled on each retry (default: 500). */
  baseDelayMs?: number;
}

/**
 * Retries `fn` up to `maxAttempts` times, using exponential backoff, but ONLY
 * when the thrown error is a transient network error. Any other error is
 * re-thrown immediately without retrying.
 *
 * @param fn - The async operation to execute and retry on transient network errors.
 * @param options - Optional retry configuration (`maxAttempts`, `baseDelayMs`).
 * @returns The resolved value of `fn`.
 * @throws {@link NetworkError} if all retry attempts fail with transient network errors, or the original error if non-transient.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }
  const originalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  throw new NetworkError(originalMessage);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Low-level Soroban RPC wrapper shared by all SDK module clients. */
export class StarboundClient {
  public readonly server: rpc.Server;
  public readonly networkPassphrase: string;
  public readonly contractIds: ContractIds;

  /**
   * @param config - RPC endpoint, network passphrase, and deployed contract IDs.
   * @throws If the runtime `@stellar/stellar-sdk` is incompatible (missing `xdr.TransactionMeta.v4`).
   */
  constructor(config: StarboundClientConfig) {
    assertCompatibleStellarSdk();
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: false });
    this.networkPassphrase = config.networkPassphrase;
    this.contractIds = config.contractIds;
  }

  /**
   * Returns a pre-configured testnet client.
   *
   * @param contractIds - Deployed contract IDs on the Stellar testnet.
   * @returns A {@link StarboundClient} pointed at the Stellar testnet RPC.
   */
  static testnet(contractIds: ContractIds): StarboundClient {
    return new StarboundClient({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      contractIds,
    });
  }

  /**
   * Returns network information for this client (#134).
   *
   * @returns Object containing network name, RPC URL, and network passphrase.
   */
  getNetworkInfo(): { network: string; rpcUrl: string; networkPassphrase: string } {
    const network =
      this.networkPassphrase === Networks.TESTNET
        ? 'testnet'
        : this.networkPassphrase === Networks.PUBLIC
          ? 'mainnet'
          : 'unknown';

    return {
      network,
      rpcUrl: (this.server as any).serverURL?.toString() ?? 'unknown',
      networkPassphrase: this.networkPassphrase,
    };
  }

  /**
   * Simulates a read-only contract call and returns its decoded native result.
   * Never submits a transaction — no account needs to be funded.
   *
   * @param contractId - The contract to call.
   * @param method - The name of the contract function to invoke.
   * @param args - Encoded `xdr.ScVal` arguments to pass to the function.
   * @returns The decoded return value of the simulated call.
   * @throws If the simulation fails or the contract returns an error.
   */
  async simulateReadCall(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<any> {
    const tx = buildReadCallTransaction(this.networkPassphrase, contractId, method, args);
    const simulation = await withRetry(() => this.server.simulateTransaction(tx));
    return decodeSimulationResult(method, simulation);
  }

  /**
   * Builds, simulates, signs, submits, and confirms a write call.
   *
   * `sign` never sees a private key here — it's the caller's job to actually
   * sign (Freighter in the frontend, a Keypair in a script), keeping this
   * client signer-agnostic.
   *
   * @param options - Source address, the Soroban operation to invoke, and a signer.
   * @returns The confirmed transaction response from the Soroban RPC.
   * @throws If simulation, signing, submission, or on-chain execution fails.
   */
  async submitTransaction(options: WriteCallOptions): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const account = await withRetry(() => this.server.getAccount(options.sourceAddress));
    const unprepared = buildUnpreparedTransaction(this.networkPassphrase, account, [options.operation]);
    const prepared = await withRetry(() => this.server.prepareTransaction(unprepared));
    return this.signAndConfirm(prepared, options.sign);
  }

  /**
   * Signs, submits, and confirms a transaction of classic (non-Soroban)
   * operations, such as trustlines. Skips simulation entirely: RPC's
   * `prepareTransaction` rejects classic operations outright
   * (`"unsupported operation type"`), verified against testnet.
   *
   * @param options - Source address, one or more classic operations, and a signer.
   * @returns The confirmed transaction response from the Soroban RPC.
   * @throws If signing, submission, or on-chain execution fails.
   */
  async submitClassicTransaction(options: ClassicCallOptions): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const account = await withRetry(() => this.server.getAccount(options.sourceAddress));
    const tx = buildUnpreparedTransaction(this.networkPassphrase, account, options.operations);
    return this.signAndConfirm(tx, options.sign);
  }

  /**
   * Hands a built transaction to the signer, submits it, and waits for its
   * final status.
   *
   * @param tx - The built (and optionally prepared) transaction to sign and submit.
   * @param sign - A {@link TransactionSigner} that provides the source account's signature.
   * @returns The confirmed transaction response once the transaction is finalised.
   * @throws If the network rejects the transaction or it fails on-chain.
   */
  private async signAndConfirm(
    tx: Transaction,
    sign: TransactionSigner
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const signedXdr = await sign(tx.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;

    const sendResult = await this.server.sendTransaction(signedTx);
    verifySendWasAccepted(sendResult);

    const finalResult = await this.server.pollTransaction(sendResult.hash);
    return verifyTransactionSucceeded(finalResult);
  }
}

/**
 * Builds an unprepared (unsimulated) transaction holding the given operations.
 *
 * @param networkPassphrase - The Stellar network passphrase.
 * @param account - The source account (must be loaded from the network).
 * @param operations - One or more operations to include in the transaction.
 * @returns An unsigned, unprepared {@link Transaction}.
 */
function buildUnpreparedTransaction(networkPassphrase: string, account: Account, operations: xdr.Operation[]): Transaction {
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase });
  for (const operation of operations) {
    builder.addOperation(operation);
  }
  return builder.setTimeout(30).build();
}

/**
 * Throws if the network didn't accept the transaction for processing.
 *
 * @param send - The response from `server.sendTransaction`.
 * @throws If the transaction status is not `'PENDING'` or `'DUPLICATE'`.
 */
function verifySendWasAccepted(send: rpc.Api.SendTransactionResponse): void {
  if (send.status !== 'PENDING' && send.status !== 'DUPLICATE') {
    throw new TransactionRejectedError(`transaction rejected: ${send.status}`);
  }
}

/**
 * Throws if the confirmed transaction failed on-chain; otherwise returns it.
 *
 * @param result - The response from `server.pollTransaction`.
 * @returns The successful transaction response.
 * @throws If the transaction status is not `SUCCESS`.
 */
function verifyTransactionSucceeded(
  result: rpc.Api.GetTransactionResponse
): rpc.Api.GetSuccessfulTransactionResponse {
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new TransactionFailedError(`transaction failed: ${result.status}`);
  }
  return result;
}

/**
 * Builds a throwaway, never-submitted transaction for simulating a read call.
 *
 * @param networkPassphrase - The Stellar network passphrase.
 * @param contractId - The contract to call.
 * @param method - The name of the contract function to invoke.
 * @param args - Encoded `xdr.ScVal` arguments to pass to the function.
 * @returns A built (but never submitted) transaction suitable for simulation.
 */
function buildReadCallTransaction(
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): ReturnType<TransactionBuilder['build']> {
  const contract = new Contract(contractId);
  // Simulation doesn't touch this account's balance or require its signature,
  // so a fresh throwaway keypair is enough — no funded account needed.
  const readOnlySource = new Account(Keypair.random().publicKey(), '0');

  return new TransactionBuilder(readOnlySource, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Extracts and decodes a simulated read call's return value, or throws its error.
 *
 * @param method - The contract method name (used in error messages only).
 * @param simulation - The simulation response from the Soroban RPC.
 * @returns The decoded native return value.
 * @throws If the simulation returned an error or no result.
 */
function decodeSimulationResult(method: string, simulation: rpc.Api.SimulateTransactionResponse): any {
  if (rpc.Api.isSimulationError(simulation)) {
    throw new SimulationError(`${method}: simulation failed — ${simulation.error}`);
  }
  if (!simulation.result) {
    throw new SimulationError(`${method}: simulation returned no result`);
  }
  return scValToNative(simulation.result.retval);
}
