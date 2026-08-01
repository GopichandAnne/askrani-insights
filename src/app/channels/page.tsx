import { activeWorkspace } from "@/lib/workspace";
import { workspaceChannels } from "@/lib/channels";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ChannelManager } from "@/components/ChannelManager";

export const dynamic = "force-dynamic";

/**
 * Channels — what we're monitoring for you and each competitor, and the controls
 * to fix it. This is where an owner attaches the Instagram/Facebook we couldn't
 * find automatically, so those posts and offers start flowing in.
 */
export default async function ChannelsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Channels" />;

  const businesses = await workspaceChannels(state.workspace);
  const watched = businesses.reduce((n, b) => n + b.socialCount, 0);

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Channels</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          The public sources we watch for {state.workspace.name} and its competitors. When our automatic
          mapping misses a business&apos;s Instagram or Facebook, attach it here and we&apos;ll start
          collecting their posts and offers on the next scan.
        </p>
      </header>

      <div className="glass rounded-2xl px-4 py-3 text-sm text-ink-soft">
        Watching <span className="font-semibold text-brand-deep">{watched}</span> social channel{watched === 1 ? "" : "s"} across{" "}
        <span className="font-semibold text-brand-deep">{businesses.length}</span> business{businesses.length === 1 ? "" : "es"}.
      </div>

      {businesses.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">
          No businesses in this workspace yet.
        </p>
      ) : (
        <div className="stagger space-y-4">
          {businesses.map((b) => (
            <ChannelManager key={b.businessId} business={b} />
          ))}
        </div>
      )}
    </div>
  );
}
