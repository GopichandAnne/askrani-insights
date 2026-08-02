import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { exploreArea } from "@/lib/explore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** No-setup area market scan: {area, keyword} → ranked businesses with ratings. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in to explore" }, { status: 401 });
  const { area, keyword } = await req.json().catch(() => ({}));
  const data = await exploreArea({ area: String(area ?? ""), keyword: String(keyword ?? "") });
  return NextResponse.json(data);
}
