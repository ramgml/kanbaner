import { handleOpenCodeStatus } from "../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleOpenCodeStatus(request);
}
