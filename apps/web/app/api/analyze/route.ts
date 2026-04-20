const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body: request.body,
    cache: "no-store",
  };

  if (request.body) {
    init.duplex = "half";
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${trimTrailingSlash(API_INTERNAL_URL)}/analyze`, init);
  } catch {
    return Response.json(
      { detail: "Could not reach Beatly API. Check that the api container is running." },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstreamResponse.headers.get("content-type");
  if (upstreamContentType) {
    responseHeaders.set("content-type", upstreamContentType);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
