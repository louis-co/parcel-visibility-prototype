import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { CURRENT_CONTRACT_VERSION, MIN_COMPATIBLE_MAJOR } from "./ingest";

const http = httpRouter();

http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body." }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    try {
      const result = await ctx.runMutation(api.ingest.ingestRawEvent, body as never);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown ingest error.";
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }),
});

http.route({
  path: "/contract/version",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        contractVersion: CURRENT_CONTRACT_VERSION,
        minCompatibleMajor: MIN_COMPATIBLE_MAJOR,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }),
});

export default http;
