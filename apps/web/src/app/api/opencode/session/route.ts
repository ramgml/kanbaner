import { handleOpenCodeSessionCreate } from "../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleOpenCodeSessionCreate(request);
}
