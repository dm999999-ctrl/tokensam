import Dashboard from "@/components/Dashboard";
import { getLiveDashboardData, latestDashboardUpdate } from "@/lib/data/live-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await getLiveDashboardData();
  return <Dashboard tokens={data.tokens} error={data.error} dataUpdatedAt={latestDashboardUpdate(data.tokens)} refreshStatus={data.refreshStatus} />;
}
