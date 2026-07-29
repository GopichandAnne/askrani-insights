import { ComingOnline } from "@/components/ComingOnline";

export default function CompetitorsPage() {
  return (
    <ComingOnline
      title="Competitors"
      blurb="Your ranked competitor graph with editable controls. Each edge shows its component scores (distance, offering overlap, category, price tier, audience, prominence) so you can understand and adjust the set."
      populatedBy="Competitor discovery (guide §9) writes competitor_edge rows with explainable score_components; this screen lets you promote, demote or exclude them."
    />
  );
}
