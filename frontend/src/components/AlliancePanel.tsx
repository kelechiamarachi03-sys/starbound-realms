import { useState } from 'react';
import { AllianceClient } from '@starbound-realms/sdk';
import { getStarboundClient } from '../lib/starboundClient';

interface AlliancePanelProps {
  walletAddress: string;
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>;
}

interface AllianceRecord {
  alliance_id?: string | number;
  name?: string;
  leader?: string;
  members?: Array<{ player?: string; role?: string }>;
}

/** Create, join, and inspect an alliance without hiding transaction failures. */
export function AlliancePanel({ walletAddress, signTransaction }: AlliancePanelProps) {
  const [name, setName] = useState('');
  const [allianceId, setAllianceId] = useState('');
  const [alliance, setAlliance] = useState<AllianceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: (client: AllianceClient) => Promise<void>, success: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const client = getStarboundClient();
      await action(new AllianceClient(client));
      setMessage(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadAlliance() {
    if (!allianceId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const client = getStarboundClient();
      const record = await new AllianceClient(client).getAlliance(allianceId.trim());
      setAlliance(record as AllianceRecord);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAlliance(null);
    } finally {
      setBusy(false);
    }
  }

  const sign = (xdr: string) => {
    const client = getStarboundClient();
    return signTransaction(xdr, client.networkPassphrase);
  };

  return (
    <section aria-labelledby="alliance-title" style={{ marginTop: '1rem', padding: '1.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <h2 id="alliance-title" style={{ fontSize: '1rem', margin: '0 0 1rem', color: 'var(--text)' }}>Alliance</h2>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run((client) => client.createAlliance(walletAddress, name.trim(), sign), 'Alliance creation submitted.'); }} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <label htmlFor="alliance-name" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Alliance name</label>
        <input id="alliance-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Alliance name" disabled={busy} />
        <button type="submit" disabled={busy || !name.trim()}>Create alliance</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); if (allianceId.trim()) void run((client) => client.joinAlliance(walletAddress, allianceId.trim(), sign), 'Alliance membership submitted.'); }} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
        <label htmlFor="alliance-id" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Alliance id</label>
        <input id="alliance-id" value={allianceId} onChange={(event) => setAllianceId(event.target.value)} placeholder="Alliance id" disabled={busy} />
        <button type="submit" disabled={busy || !allianceId.trim()}>Join alliance</button>
        <button type="button" onClick={() => void loadAlliance()} disabled={busy || !allianceId.trim()}>View membership</button>
      </form>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {alliance && (
        <div aria-label="Alliance membership" style={{ marginTop: '1rem' }}>
          <strong>{alliance.name ?? `Alliance ${alliance.alliance_id ?? allianceId}`}</strong>
          {alliance.leader && <p>Leader: {alliance.leader}</p>}
          <p>Members: {alliance.members?.length ?? 0}</p>
          <ul>{alliance.members?.map((member) => <li key={member.player}>{member.player}{member.role ? ` (${member.role})` : ''}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
