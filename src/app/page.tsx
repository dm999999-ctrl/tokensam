import Dashboard from "@/components/Dashboard";
import { AppShell } from "@/components/AppShell";
import { getLiveDashboardData, latestDashboardUpdate } from "@/lib/data/live-data";
import { selectMovers } from "@/lib/ui/movers";
import { CALCULATED_METRICS } from "@/lib/metrics/engine";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await getLiveDashboardData();
  // Movers come from the rows already loaded for the dashboard: no extra reads.
  return (
    <AppShell active="universe" movers={data.error ? null : selectMovers(data.tokens)}>
      <Dashboard
        tokens={data.tokens}
        error={data.error}
        dataUpdatedAt={latestDashboardUpdate(data.tokens)}
        refreshStatus={data.refreshStatus}
        metricsPerAsset={CALCULATED_METRICS.length}
      />
    </AppShell>
  );
}
