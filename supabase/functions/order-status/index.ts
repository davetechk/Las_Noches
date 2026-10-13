// supabase/functions/order-status/index.ts
//
// The success page asks "is my order done, and what's my code?"
// Orders are not readable from the browser directly — this is the only
// window onto them, and it only ever returns one order by its reference.
//
// It also falls back to verifying with Paystack directly. Webhooks can be
// delayed by a few seconds, and a customer staring at a blank screen will
// assume they've been robbed.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const sbHeaders = {
  "Content-Type": "application/json",
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function loadOrder(reference: string) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?reference=eq.${reference}` +
    `&select=reference,status,voucher_code,duration_hrs,amount_ngn,paid_at,entry_id`,
    { headers: sbHeaders },
  );
  return (await r.json())?.[0] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const reference = url.searchParams.get("reference");
  if (!reference) return json({ error: "reference required" }, 400);

  try {
    let order = await loadOrder(reference);
    if (!order) return json({ error: "Order not found." }, 404);

    // Still pending? The webhook may not have landed yet. Ask Paystack
    // directly, and if the money is really there, issue it now.
    if (order.status === "pending") {
      const vRes = await fetch(
        `https://api.paystack.co/transaction/verify/${reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_KEY}` } },
      );
      const v = await vRes.json();

      if (v?.status && v.data?.status === "success" &&
          v.data?.amount === order.amount_ngn * 100) {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_online_entry`, {
          method: "POST",
          headers: sbHeaders,
          body: JSON.stringify({ p_reference: reference }),
        });
        order = await loadOrder(reference);
      }
    }

    // Attach when the time runs out, so the page can show a countdown.
    let expires_at = null;
    if (order.entry_id) {
      const eRes = await fetch(
        `${SUPABASE_URL}/rest/v1/entries?id=eq.${order.entry_id}&select=expires_at`,
        { headers: sbHeaders },
      );
      expires_at = (await eRes.json())?.[0]?.expires_at ?? null;
    }

    return json({
      reference: order.reference,
      status: order.status,
      voucher_code: order.voucher_code,
      duration_hrs: order.duration_hrs,
      amount_ngn: order.amount_ngn,
      expires_at,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Could not check that order." }, 500);
  }
});
