import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// --- Landing page demo vote endpoints ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

http.route({
  path: "/api/demo-vote",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();
    const choice = body.choice;
    if (choice !== "A" && choice !== "B") {
      return new Response(JSON.stringify({ error: "Invalid choice" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    await ctx.runMutation(internal.demoVotes.castVote, { choice });
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-vote",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

export default http;
