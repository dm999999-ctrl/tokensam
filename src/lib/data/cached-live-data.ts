import "server-only";

import { unstable_cache } from "next/cache";
import { getLiveDashboardData, getLiveTokenProfile, getSidebarMovers } from "./live-data.ts";

// Cached server-side because the dashboard/profile payloads require several reads and
// CPU-heavy transforms (history assembly and technical indicators). Refresh runs
// invalidate these tags as soon as new observations are persisted.
const CACHE_SECONDS = 5 * 60;

export async function getCachedLiveDashboardData() {
  try {
    return await unstable_cache(
      async () => {
        const data = await getLiveDashboardData();
        // Do not persist a transient database failure as a successful cache entry.
        if (data.error) throw new Error(data.error);
        return data;
      },
      ["live-dashboard-v1"],
      { revalidate: CACHE_SECONDS, tags: ["live-dashboard-data"] },
    )();
  } catch {
    return {
      tokens: [],
      error: "Live data is temporarily unavailable. No demo data is being shown.",
      refreshStatus: null,
    };
  }
}

export function getCachedLiveTokenProfile(tokenId: string) {
  return unstable_cache(
    async (id: string) => getLiveTokenProfile(id),
    ["live-token-profile-v1"],
    {
      revalidate: CACHE_SECONDS,
      tags: ["live-token-profile-data", `live-token-profile-${tokenId}`],
    },
  )(tokenId);
}

export const getCachedSidebarMovers = unstable_cache(
  async () => getSidebarMovers(),
  ["live-sidebar-movers-v1"],
  { revalidate: CACHE_SECONDS, tags: ["live-sidebar-movers"] },
);
