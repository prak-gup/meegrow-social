import { DateTime } from 'luxon';
import type { AnalyticsReportView } from '@meegrow-social/contracts';
type Report = AnalyticsReportView;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const names = { video: 'Video', image: 'Image', text: 'Text' };
const platforms: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  gmb: 'Google Business',
  bluesky: 'Bluesky',
  wordpress: 'WordPress',
};
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const slotLabel = (day: number, hour: number) =>
  `${days[day]} ${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
/** Stable, descriptive findings; thresholds gate observations, not statistical significance. */
export function analyticsDisplayFacts(
  report: Report,
): Pick<Report, 'insights' | 'formatWinner' | 'platformShares' | 'followerTrend' | 'bestSlots'> {
  const insights: NonNullable<Report['insights']> = [];
  const eligible = report.formats.filter(
    (f) =>
      f.engagementRate.postsCounted >= 5 &&
      f.engagementRate.rate !== null &&
      f.engagementRate.basis !== 'mixed',
  );
  const pairs = eligible
    .flatMap((a) =>
      eligible
        .filter(
          (b) =>
            a.format !== b.format &&
            a.engagementRate.basis === b.engagementRate.basis &&
            a.engagementRate.components.join() === b.engagementRate.components.join() &&
            a.engagementRate.rate! > b.engagementRate.rate!,
        )
        .map((b) => ({ a, b })),
    )
    .sort(
      (x, y) =>
        y.a.engagementRate.rate! - x.a.engagementRate.rate! ||
        x.a.format.localeCompare(y.a.format) ||
        x.b.format.localeCompare(y.b.format),
    );
  const pair = pairs[0];
  if (pair)
    insights.push({
      kind: 'format',
      title: `${names[pair.a.format]} outperforms ${names[pair.b.format].toLowerCase()}`,
      detail: `${fmt(pair.a.engagementRate.rate!)}% vs ${fmt(pair.b.engagementRate.rate!)}% engagement (${pair.a.engagementRate.postsCounted} vs ${pair.b.engagementRate.postsCounted} measured posts)`,
    });
  const slots = report.bestTimes.cells
    .filter((c) => (c.postsCounted ?? 0) >= 3 && c.average !== null)
    .sort((a, b) => b.average! - a.average! || a.weekday - b.weekday || a.hour - b.hour);
  const slot = slots[0];
  if (slot && report.bestTimes.by === 'engagements')
    insights.push({
      kind: 'time',
      title: `Best slot: ${slotLabel(slot.weekday, slot.hour)}`,
      detail: `${fmt(slot.average!)} avg engagements across ${slot.postsCounted} measured posts`,
    });
  const best = report.summary.bestPost;
  const total = report.summary.engagementRate.engagements;
  if (best?.by === 'engagements' && total !== null && total > 0 && report.summary.posts.value! >= 5)
    insights.push({
      kind: 'post',
      title: `Top post drove ${fmt((best.value / total) * 100)}% of engagement`,
      detail: best.post.caption.replace(/\s+/g, ' ').trim() || 'Untitled post',
    });
  const reach = report.summary.totals.reach.value;
  const platformShares = report.byPlatform.map((p) => ({
    provider: p.provider,
    reachPct:
      reach !== null && reach > 0 && p.totals.reach !== null
        ? (p.totals.reach / reach) * 100
        : null,
  }));
  const leader = [...platformShares]
    .filter((p) => p.reachPct !== null)
    .sort((a, b) => b.reachPct! - a.reachPct! || a.provider.localeCompare(b.provider))[0];
  const leaderRow = report.byPlatform.find((p) => p.provider === leader?.provider);
  if (
    leader &&
    leaderRow &&
    leaderRow.posts >= 5 &&
    platformShares.filter((p) => p.reachPct !== null).length >= 2
  )
    insights.push({
      kind: 'platform',
      title: `${platforms[leader.provider] ?? leader.provider} delivers ${fmt(leader.reachPct!)}% of reach`,
      detail: `${fmt(leaderRow.totals.reach!)} of ${fmt(reach!)} reported reach`,
    });
  const delta = report.summary.totals.reach;
  if (
    delta.prior !== null &&
    delta.prior > 0 &&
    delta.value !== null &&
    delta.deltaPct !== null &&
    Number.isFinite(delta.deltaPct) &&
    delta.deltaPct !== 0
  )
    insights.push({
      kind: 'delta',
      title: `Reach ${delta.deltaPct > 0 ? 'up' : 'down'} ${fmt(Math.abs(delta.deltaPct))}%`,
      detail: `${fmt(delta.value)} vs ${fmt(delta.prior)} in the previous publication period`,
    });
  const selected = report.accounts.filter(
    (a) =>
      a.selected && report.mapping.some((m) => m.provider === a.provider && m.followers.length),
  );
  const weeks = report.weeklySeries ?? report.overTime;
  const followerTrend = (selected.length ? weeks : []).map((bucket) => {
    const values = selected.map((account) => {
      const points = report.followerSeries.find((s) => s.connectionId === account.id)?.points ?? [];
      const own = points.filter(
        (p) =>
          DateTime.fromISO(p.day, { zone: report.timezone }).startOf('week').toISODate() ===
          bucket.key,
      );
      return [...own].sort((a, b) => a.day.localeCompare(b.day)).at(-1)?.value ?? null;
    });
    return {
      day: bucket.key,
      value:
        values.length > 0 && values.every((v) => v !== null)
          ? values.reduce<number>((sum, v) => sum + v!, 0)
          : null,
    };
  });
  return {
    bestSlots: slots.slice(0, 3).map((s) => ({
      weekday: s.weekday,
      hour: s.hour,
      posts: s.postsCounted!,
      average: s.average!,
    })),
    insights: insights.slice(0, 4),
    formatWinner: pair?.a.format ?? null,
    platformShares,
    followerTrend,
  };
}
