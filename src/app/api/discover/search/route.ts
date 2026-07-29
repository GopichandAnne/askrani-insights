import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { searchBusinesses } from "@/lib/discovery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { query, near } = await req.json().catch(() => ({}));
  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return badRequest("query must be at least 2 characters");
  }
  try {
    const results = await searchBusinesses(query.trim(), near);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
