import {
  handleOpenCodeSessionCreate,
  handleOpenCodeSessionList,
} from "../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleOpenCodeSessionList(request);
}

export function POST(request: Request): Promise<Response> {
  return handleOpenCodeSessionCreate(request);
}
