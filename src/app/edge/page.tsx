import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { EdgeView } from "@/components/EdgeView";

export const dynamic = "force-dynamic";

/**
 * "Your Edge" — the value view. Every signal we collect, synthesized into what
 * competitors do differently, what customers really think, what's trending, what
 * offerings win, and what's coming up — each with a move you can make.
 */
export default async function EdgePage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Your Edge" />;

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Your Edge</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Everything we&apos;re seeing across {state.workspace.name}&apos;s market — what rivals do differently,
          what people really think, what&apos;s trending, and what to do about it.
        </p>
      </header>
      <EdgeView />
    </div>
  );
}
