import { ComingOnline } from "@/components/ComingOnline";

export default function FeedPage() {
  return (
    <ComingOnline
      title="Market feed"
      blurb="A unified timeline of observed competitor activity: posts, promotions, menu changes, reviews, price moves and events — filterable by competitor, event type, platform and date."
      populatedBy="Once a workspace is monitoring competitors, each collection run appends normalized content_items and market_events here."
    />
  );
}
