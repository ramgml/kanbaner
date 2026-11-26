import {
  handleOpenCodeSessionGet,
  handleOpenCodeSessionRename,
} from "../../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionRouteContext {
  readonly params: Promise<{ readonly sessionID: string }>;
}

export function GET(request: Request, context: SessionRouteContext): Promise<Response> {
  return context.params.then(({ sessionID }) => handleOpenCodeSessionGet(sessionID, request));
}

export function PATCH(request: Request, context: SessionRouteContext): Promise<Response> {
  return context.params.then(({ sessionID }) => handleOpenCodeSessionRename(sessionID, request));
}
