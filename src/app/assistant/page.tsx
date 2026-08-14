import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { AssistantChat } from "@/components/AssistantChat";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Ask Rani" />;
  const ws = state.workspace;

  return (
    <div className="animate-fade-in space-y-4">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Ask Rani</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Your market advisor — ask anything about {ws.name} and your local rivals. Answers come from your own collected data (never made up), plus timely moves for what to run next.
        </p>
      </div>

      <AssistantChat businessName={ws.name} />
    </div>
  );
}
