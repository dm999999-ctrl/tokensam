/** Additional illustrative fields for the demo Token Profile route. */
export type TokenProfileDetails = {
  description: string;
  contractAddress: string | null;
  contractNote: string;
  revenueChange30dPct: number | null;
  marketCapRank: number | null;
  marketStructure: string | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maximumSupply: number | null;
  nextUnlock: string | null;
  nextUnlockPct: number | null;
  dataNotes: string[];
};
