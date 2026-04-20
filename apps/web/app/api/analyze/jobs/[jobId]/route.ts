const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_: Request, context: RouteContext): Promise<Response> {
  const { jobId } = await context.params;
  try {
    const upstreamResponse = await fetch(
      `${trimTrailingSlash(API_INTERNAL_URL)}/analyze/jobs/${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
    );
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: copyContentType(upstreamResponse.headers),
    });
  } catch {
    return Response.json(
      { detail: "Could not reach Beatly API. Check that the api container is running." },
      { status: 502 },
    );
  }
}

function copyContentType(headers: Headers): Headers {
  const responseHeaders = new Headers();
  const contentType = headers.get("content-type");
  if (contentType) {
    responseHeaders.set("content-type", contentType);
  }
  return responseHeaders;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
