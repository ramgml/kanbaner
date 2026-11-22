import { handleCommandRequest } from "../../../../../server/http-api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CommandRouteContext {
  readonly params: Promise<{ readonly commandId: string }>;
}

export async function POST(request: Request, context: CommandRouteContext): Promise<Response> {
  const { commandId } = await context.params;

  return handleCommandRequest(request, commandId);
}
