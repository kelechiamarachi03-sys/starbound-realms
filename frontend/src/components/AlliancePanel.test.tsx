import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AlliancePanel } from './AlliancePanel';

const createAlliance = vi.fn();
const joinAlliance = vi.fn();
const getAlliance = vi.fn();
const getStarboundClient = vi.fn(() => ({ networkPassphrase: 'TESTNET' }));

vi.mock('@starbound-realms/sdk', () => ({
  AllianceClient: vi.fn().mockImplementation(() => ({ createAlliance, joinAlliance, getAlliance })),
}));
vi.mock('../lib/starboundClient', () => ({ getStarboundClient }));

describe('AlliancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAlliance.mockResolvedValue(undefined);
    joinAlliance.mockResolvedValue(undefined);
    getAlliance.mockResolvedValue({ alliance_id: '42', name: 'Star League', leader: 'GLEADER', members: [{ player: 'GPLAYER', role: 'member' }] });
  });

  it('creates an alliance with the connected wallet and signs using the configured network', async () => {
    const sign = vi.fn().mockResolvedValue('signed');
    render(<AlliancePanel walletAddress="GPLAYER" signTransaction={sign} />);
    fireEvent.change(screen.getByLabelText('Alliance name'), { target: { value: 'Star League' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create alliance' }));
    await waitFor(() => expect(createAlliance).toHaveBeenCalledWith('GPLAYER', 'Star League', expect.any(Function)));
    const signer = createAlliance.mock.calls[0][2];
    await signer('xdr');
    expect(sign).toHaveBeenCalledWith('xdr', 'TESTNET');
  });

  it('joins and loads membership by alliance id', async () => {
    render(<AlliancePanel walletAddress="GPLAYER" signTransaction={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Alliance id'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join alliance' }));
    await waitFor(() => expect(joinAlliance).toHaveBeenCalledWith('GPLAYER', '42', expect.any(Function)));
    fireEvent.click(screen.getByRole('button', { name: 'View membership' }));
    await waitFor(() => expect(getAlliance).toHaveBeenCalledWith('42'));
    expect(screen.getByText('Star League')).toBeInTheDocument();
    expect(screen.getByText(/Members: 1/)).toBeInTheDocument();
  });
});
