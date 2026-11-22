import { handleResourceRequest } from "../../../../../server/http-api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResourceRouteContext {
  readonly params: Promise<{ readonly encodedResourceRef: string }>;
}

export async function GET(request: Request, context: ResourceRouteContext): Promise<Response> {
  const { encodedResourceRef } = await context.params;

  return handleResourceRequest(request, encodedResourceRef);
}
