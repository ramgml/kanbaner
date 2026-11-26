import { handleOpenCodeModelSwitch } from "../../../../../../server/opencode-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ModelRouteContext {
  readonly params: Promise<{ readonly sessionID: string }>;
}

export async function POST(request: Request, context: ModelRouteContext): Promise<Response> {
  const { sessionID } = await context.params;
  return handleOpenCodeModelSwitch(sessionID, request);
}
