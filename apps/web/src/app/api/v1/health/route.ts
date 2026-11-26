import { handleHealthRequest } from "../../../../server/http-api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleHealthRequest(request);
}
