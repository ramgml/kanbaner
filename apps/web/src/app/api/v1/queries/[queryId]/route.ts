import { handleQueryRequest } from "../../../../../server/http-api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface QueryRouteContext {
  readonly params: Promise<{ readonly queryId: string }>;
}

export async function POST(request: Request, context: QueryRouteContext): Promise<Response> {
  const { queryId } = await context.params;

  return handleQueryRequest(request, queryId);
}
