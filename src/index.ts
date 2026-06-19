/**
 * docker-mcp-hosted — Cloudflare Worker (Phase 4: Payment Integration)
 *
 * Architecture: AI Client → Routing Worker (auth, metering, payments) → Cloudflare Tunnel → User's Docker MCP Server
 *
 * The Docker daemon stays on the user's host. This Worker is the edge gateway.
 * It authenticates requests, enforces tier limits, processes payments,
 * and proxies MCP protocol messages through a Cloudflare Tunnel.
 *
 * Free tier: read-only tools (list, inspect, status), 30 req/min
 * Standard tier ($19/mo): full access (all 50 tools), 120 req/min
 *
 * Phase 1: Scaffold — API key auth via KV, tool forwarding via tunnel (DONE)
 * Phase 2: Tunnel bridge — actual HTTP proxy to user's Docker MCP via tunnel (DONE)
 * Phase 3: Deploy to Cloudflare Workers (DONE)
 * Phase 4: Payment integration — USDC subscription + session tokens (THIS)
 */

// --- Constants ---
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const USDC_DECIMALS = 6;
const SUBSCRIPTION_AMOUNT = 19; // $19 USD
const SUBSCRIPTION_AMOUNT_RAW = BigInt(SUBSCRIPTION_AMOUNT) * BigInt(10 ** USDC_DECIMALS);
const BASE_RPC = "https://mainnet.base.org";
const FREE_TIER = "free";
const STANDARD_TIER = "standard";

// --- Types ---
interface Env {
  API_KEYS: KVNamespace;
  SUBSCRIPTIONS: KVNamespace;
  MCP_SERVER: DurableObjectNamespace;
  NOVA_WALLET: string; // Nova's USDC receiving address
}

interface ApiKeyRecord {
  tier: "free" | "standard";
  userId: string;
  tunnelUrl: string;
  createdAt: string;
}

interface SubscriptionRecord {
  wallet: string;
  tier: "standard";
  activatedAt: string;
  expiresAt: string;
  txHash: string;
}

interface PendingSubscription {
  wallet: string;
  createdAt: string;
  amount: string;
  memo: string;
}

// --- CORS ---
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

// --- Auth ---
async function validateApiKey(
  request: Request,
  env: Env
): Promise<{ valid: boolean; record?: ApiKeyRecord }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false };
  }
  const key = authHeader.slice(7);

  const record = await env.API_KEYS.get<ApiKeyRecord>(key, { type: "json" });
  if (!record) {
    return { valid: false };
  }

  return { valid: true, record };
}

// --- Subscription Token Validation ---
async function validateSubscription(
  request: Request,
  env: Env
): Promise<{ subscribed: boolean; subscription?: SubscriptionRecord }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { subscribed: false };
  }
  const token = authHeader.slice(7);

  const sub = await env.SUBSCRIPTIONS.get<SubscriptionRecord>(token, { type: "json" });
  if (!sub) {
    return { subscribed: false };
  }

  // Check expiry
  if (new Date(sub.expiresAt) < new Date()) {
    await env.SUBSCRIPTIONS.delete(token);
    return { subscribed: false };
  }

  return { subscribed: true, subscription: sub };
}

// --- Tool tier enforcement ---
const FREE_TOOLS = new Set([
  "list_containers",
  "inspect_container",
  "container_health_status",
  "check_health",
  "fleet_status",
  "list_images",
  "list_networks",
  "list_volumes",
]);

// --- Payment Verification (Base RPC) ---
async function verifyUSDCTransfer(
  txHash: string,
  expectedTo: string,
  expectedAmount: bigint
): Promise<{ verified: boolean; from?: string; error?: string }> {
  try {
    const response = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params: [txHash],
        id: 1,
      }),
    });

    const data = await response.json<{ result?: { status: string; logs: Array<{ address: string; topics: string[]; data: string }> } }>();
    if (!data.result) {
      return { verified: false, error: "Transaction not found" };
    }

    if (data.result.status !== "0x1") {
      return { verified: false, error: "Transaction failed" };
    }

    // Look for USDC Transfer event (topic 0xddf252ad...)
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    for (const log of data.result.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;

      const to = "0x" + log.topics[2].slice(26).toLowerCase();
      const amount = BigInt(log.data);

      if (to === expectedTo.toLowerCase() && amount === expectedAmount) {
        const from = "0x" + log.topics[1].slice(26);
        return { verified: true, from };
      }
    }

    return { verified: false, error: "USDC transfer not found in transaction" };
  } catch (err) {
    return { verified: false, error: `RPC error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Tunnel Proxy ---
async function proxyToTunnel(
  request: Request,
  tunnelUrl: string,
  tier: string
): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = `${tunnelUrl}${url.pathname}${url.search}`;

  const tunnelRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // @ts-ignore — duplex is needed for streaming body
    duplex: "half",
  });

  tunnelRequest.headers.delete("host");

  try {
    const response = await fetch(tunnelRequest);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "tunnel_unreachable",
        message: `Could not reach your Docker MCP server at ${tunnelUrl}. Make sure cloudflared is running.`,
        details: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// --- Durable Object: Per-user rate limiting & session state ---
export class McpGateway {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const userId = url.searchParams.get("userId") || "unknown";
    const now = Date.now();
    const windowMs = 60_000;
    const maxRequests = url.searchParams.get("tier") === "standard" ? 120 : 30;

    const key = `ratelimit:${userId}:${Math.floor(now / windowMs)}`;
    const current = (await this.state.storage.get<number>(key)) || 0;

    if (current >= maxRequests) {
      return new Response(
        JSON.stringify({ error: "rate_limited", retryAfter: windowMs - (now % windowMs) }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    await this.state.storage.put(key, current + 1);

    const sessionKey = `session:${userId}`;
    const session = (await this.state.storage.get<{ lastActive: string; totalRequests: number }>(sessionKey)) || {
      lastActive: new Date().toISOString(),
      totalRequests: 0,
    };
    session.lastActive = new Date().toISOString();
    session.totalRequests += 1;
    await this.state.storage.put(sessionKey, session);

    return new Response(JSON.stringify({ ok: true, remaining: maxRequests - current - 1 }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// --- Request handler ---
async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Check for active subscription first (standard tier bypass)
  const { subscribed, subscription } = await validateSubscription(request, env);

  if (subscribed && subscription) {
    // Standard tier — full access, rate limit via DO
    const doId = env.MCP_SERVER.idFromName(subscription.wallet);
    const doStub = env.MCP_SERVER.get(doId);
    const rateLimitResponse = await doStub.fetch(
      new Request(`https://gateway/ratelimit?userId=${subscription.wallet}&tier=${STANDARD_TIER}`)
    );
    const rateLimitResult = await rateLimitResponse.json<{ ok?: boolean; error?: string }>();
    if (!rateLimitResult.ok) {
      return new Response(
        JSON.stringify({ error: "Rate limited. Try again in a minute." }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get tunnel URL from API keys (subscription wallet is the userId)
    const apiKeyRecord = await env.API_KEYS.get<ApiKeyRecord>(subscription.wallet, { type: "json" });
    if (!apiKeyRecord) {
      return new Response(
        JSON.stringify({ error: "No tunnel configured. Set up your tunnel URL first." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    return proxyToTunnel(request, apiKeyRecord.tunnelUrl, STANDARD_TIER);
  }

  // Fall back to API key auth (free tier or legacy)
  const { valid, record } = await validateApiKey(request, env);
  if (!valid || !record) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing API key or subscription token" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Rate limit via Durable Object
  const doId = env.MCP_SERVER.idFromName(record.userId);
  const doStub = env.MCP_SERVER.get(doId);
  const rateLimitResponse = await doStub.fetch(
    new Request(`https://gateway/ratelimit?userId=${record.userId}&tier=${record.tier}`)
  );
  const rateLimitResult = await rateLimitResponse.json<{ ok?: boolean; error?: string }>();
  if (!rateLimitResult.ok) {
    return new Response(
      JSON.stringify({ error: "Rate limited. Try again in a minute." }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // Check tool access for tool-call requests
  if (request.method === "POST") {
    try {
      const cloned = request.clone();
      const body = await cloned.json<{ method?: string; params?: { name?: string } }>();
      if (body.method === "tools/call" && body.params?.name) {
        const toolName = body.params.name;
        if (record.tier === "free" && !FREE_TOOLS.has(toolName)) {
          return new Response(
            JSON.stringify({
              error: "upgrade_required",
              message: `Tool "${toolName}" requires Standard tier ($19/mo). Free tier includes: ${Array.from(FREE_TOOLS).join(", ")}.`,
              upgradeUrl: "https://docker-mcp-hosted.friendlygeorge0220.workers.dev/pricing",
            }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    } catch {
      // Not JSON or parsing failed — let the tunnel handle it
    }
  }

  // Proxy to user's Docker MCP server via Cloudflare Tunnel
  return proxyToTunnel(request, record.tunnelUrl, record.tier);
}

// --- Entry point ---
export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(
        new Response(JSON.stringify({ status: "ok", version: "0.4.0-phase4" }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // --- Subscription Endpoints ---

    // POST /api/subscribe — Generate payment instructions
    if (request.method === "POST" && url.pathname === "/api/subscribe") {
      try {
        const { wallet } = await request.json<{ wallet?: string }>();
        if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
          return withCors(
            new Response(
              JSON.stringify({ error: "Invalid wallet address. Must be a 0x-prefixed 40 hex char address." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        const memo = `docker-mcp-${wallet.slice(0, 8)}-${Date.now()}`;

        // Store pending subscription
        const pending: PendingSubscription = {
          wallet: wallet.toLowerCase(),
          createdAt: new Date().toISOString(),
          amount: SUBSCRIPTION_AMOUNT_RAW.toString(),
          memo,
        };
        await env.SUBSCRIPTIONS.put(`pending:${wallet.toLowerCase()}`, JSON.stringify(pending), {
          expirationTtl: 3600, // 1 hour to complete payment
        });

        return withCors(
          new Response(
            JSON.stringify({
              amount: SUBSCRIPTION_AMOUNT_RAW.toString(),
              amountDisplay: `$${SUBSCRIPTION_AMOUNT} USDC`,
              asset: "USDC",
              network: "Base",
              chainId: 8453,
              payTo: env.NOVA_WALLET,
              memo,
              contractAddress: USDC_CONTRACT,
              instructions: [
                `1. Send exactly ${SUBSCRIPTION_AMOUNT} USDC to: ${env.NOVA_WALLET}`,
                `2. On Base network (chain ID 8453)`,
                `3. Include memo: ${memo}`,
                `4. After sending, POST /api/verify with your transaction hash`,
              ],
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              verifyEndpoint: `${url.origin}/api/verify`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      } catch {
        return withCors(
          new Response(
            JSON.stringify({ error: "Invalid request body. Send JSON with { wallet: \"0x...\" }" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          )
        );
      }
    }

    // POST /api/verify — Verify USDC payment and issue subscription token
    if (request.method === "POST" && url.pathname === "/api/verify") {
      try {
        const { txHash, wallet } = await request.json<{ txHash?: string; wallet?: string }>();
        if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          return withCors(
            new Response(
              JSON.stringify({ error: "Invalid transaction hash. Must be a 0x-prefixed 64 hex char hash." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        // Check for pending subscription
        const walletLower = wallet?.toLowerCase();
        if (!walletLower) {
          return withCors(
            new Response(
              JSON.stringify({ error: "Wallet address required. Call /api/subscribe first." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        const pending = await env.SUBSCRIPTIONS.get<PendingSubscription>(
          `pending:${walletLower}`,
          { type: "json" }
        );
        if (!pending) {
          return withCors(
            new Response(
              JSON.stringify({ error: "No pending subscription found. Call /api/subscribe first." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        // Verify on-chain
        const { verified, from, error } = await verifyUSDCTransfer(
          txHash,
          env.NOVA_WALLET,
          SUBSCRIPTION_AMOUNT_RAW
        );

        if (!verified) {
          return withCors(
            new Response(
              JSON.stringify({ error: `Payment verification failed: ${error}` }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        // Verify sender matches
        if (from?.toLowerCase() !== walletLower) {
          return withCors(
            new Response(
              JSON.stringify({ error: "Transaction sender does not match subscription wallet." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        // Issue subscription token
        const token = crypto.randomUUID();
        const now = Date.now();
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days

        const subRecord: SubscriptionRecord = {
          wallet: walletLower,
          tier: STANDARD_TIER,
          activatedAt: new Date().toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          txHash,
        };

        await env.SUBSCRIPTIONS.put(token, JSON.stringify(subRecord), {
          expirationTtl: 30 * 24 * 60 * 60, // 30 days
        });

        // Clean up pending
        await env.SUBSCRIPTIONS.delete(`pending:${walletLower}`);

        return withCors(
          new Response(
            JSON.stringify({
              success: true,
              token,
              tier: STANDARD_TIER,
              expiresAt: subRecord.expiresAt,
              message: "Subscription activated! Use this token as your Bearer token.",
              usage: {
                header: "Authorization: Bearer " + token,
                description: "Include this header in all MCP requests for full access.",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      } catch {
        return withCors(
          new Response(
            JSON.stringify({ error: "Invalid request body. Send JSON with { txHash: \"0x...\", wallet: \"0x...\" }" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          )
        );
      }
    }

    // GET /api/subscription/status — Check subscription status
    if (request.method === "GET" && url.pathname === "/api/subscription/status") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return withCors(
          new Response(
            JSON.stringify({ error: "Authorization header required" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      const token = authHeader.slice(7);
      const sub = await env.SUBSCRIPTIONS.get<SubscriptionRecord>(token, { type: "json" });

      if (!sub) {
        return withCors(
          new Response(
            JSON.stringify({ subscribed: false, error: "Invalid or expired subscription token" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }

      const isActive = new Date(sub.expiresAt) > new Date();
      return withCors(
        new Response(
          JSON.stringify({
            subscribed: isActive,
            tier: sub.tier,
            activatedAt: sub.activatedAt,
            expiresAt: sub.expiresAt,
            daysRemaining: isActive
              ? Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
              : 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    // --- MCP endpoint ---

    if (url.pathname === "/mcp") {
      return withCors(await handleMcpRequest(request, env, ctx));
    }

    // --- Static Pages ---

    // Pricing page
    if (url.pathname === "/pricing") {
      return withCors(
        new Response(
          `<!DOCTYPE html>
<html><head><title>Docker MCP Hosted — Pricing</title>
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;color:#1a1a1a}
.card{border:2px solid #ddd;border-radius:12px;padding:24px;margin:16px 0;transition:border-color 0.2s}
.free{border-color:#4caf50}.paid{border-color:#2196f3;background:#f8f9ff}
h1{color:#333}h2{margin-top:0}ul{padding-left:20px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
.badge-free{background:#e8f5e9;color:#2e7d32}.badge-paid{background:#e3f2fd;color:#1565c0}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:13px}
.step{background:#f8f9fa;padding:16px;border-radius:8px;margin:12px 0;border-left:3px solid #2196f3}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:14px}</style></head>
<body><h1>🐳 Docker MCP Hosted</h1>
<p>Manage Docker from any AI client. Your Docker daemon stays on your machine — we just provide the edge gateway.</p>
<div class="card free"><h2>Free <span class="badge badge-free">FREE</span></h2>
<p><strong>$0/mo</strong></p>
<ul><li>8 read-only tools (list, inspect, status)</li><li>1 tunnel connection</li><li>30 requests/min</li></ul>
<p><em>Get started: install docker-mcp-server, run cloudflared tunnel, connect your AI client.</em></p></div>
<div class="card paid"><h2>Standard <span class="badge badge-paid">POPULAR</span></h2>
<p><strong>$19/mo</strong> — paid via USDC on Base</p>
<ul><li>All 50 Docker management tools</li><li>Compose lifecycle, exec, monitoring</li><li>120 requests/min</li><li>Priority support</li></ul>
<div class="step"><strong>How to subscribe:</strong><br>
1. POST <code>/api/subscribe</code> with your wallet address<br>
2. Send 19 USDC to the provided address on Base<br>
3. POST <code>/api/verify</code> with your transaction hash<br>
4. Use the returned token as your Bearer token</div></div>
<div class="footer">
<p><em>Powered by <a href="https://github.com/friendlygeorge/docker-mcp-server">Docker MCP Server</a></em></p>
<p>Privacy-first: Your Docker data stays on your machine. We only route MCP protocol messages.</p></div>
</body></html>`,
          { headers: { "Content-Type": "text/html" } }
        )
      );
    }

    // API info
    return withCors(
      new Response(
        JSON.stringify({
          name: "Docker MCP Hosted",
          version: "0.4.0-phase4",
          description: "Edge gateway for self-hosted Docker MCP servers",
          endpoints: {
            mcp: "POST /mcp — MCP protocol endpoint (requires Authorization header)",
            health: "GET /health — Health check",
            pricing: "GET /pricing — Pricing page",
            subscribe: "POST /api/subscribe — Get payment instructions (body: {wallet})",
            verify: "POST /api/verify — Verify payment & get token (body: {txHash, wallet})",
            status: "GET /api/subscription/status — Check subscription (Authorization header)",
          },
          tiers: {
            free: "Read-only (8 tools), 30 req/min",
            standard: "$19/mo — all 50 tools, 120 req/min",
          },
          payment: {
            method: "USDC on Base",
            amount: "$19/mo",
            wallet: env.NOVA_WALLET,
            contract: USDC_CONTRACT,
          },
          setup: "1. Install docker-mcp-server locally. 2. Run cloudflared tunnel. 3. Register your tunnel URL. 4. Connect your AI client to this gateway.",
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
  },
};
