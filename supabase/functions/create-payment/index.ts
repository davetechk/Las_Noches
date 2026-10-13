// supabase/functions/create-payment/index.ts
//
// Starts a Paystack checkout. The browser only says which plan it wants —
// the price is read from the database here, so editing the page's
// JavaScript cannot change what someone pays.
//
// No customer details are collected. Paystack insists on an email for every
// transaction, so one is generated here from the order reference. It is never
// shown to anyone; orders.email and orders.phone simply stay null.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;
const SITE_URL     = Deno.env.get("SITE_URL") ?? "https://lasnoches.netlify.app";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  try {
    const { duration_hrs } = await req.json();

    if (!duration_hrs) return json({ error: "Pick how long you want." }, 400);

    // ── price comes from the database, never from the request ──
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pricing?duration_hrs=eq.${duration_hrs}&is_active=eq.true&select=*`,
      { headers: sbHeaders },
    );
    const plans = await pRes.json();
    const plan = plans?.[0];
    if (!plan) return json({ error: "That option is not available." }, 400);

    // ── is there anything left to sell? ──
    const vRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vouchers?status=eq.unused&duration_hrs=eq.${duration_hrs}` +
      `&omada_status=neq.expired&select=code&limit=1`,
      { headers: sbHeaders },
    );
    const stock = await vRes.json();
    if (!Array.isArray(stock) || stock.length === 0) {
      return json({
        error: `${plan.label} is sold out right now. Try another length or message us on WhatsApp.`,
        sold_out: true,
      }, 409);
    }

    const reference = `ln_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const guestEmail = `guest+${reference}@lasnoches.local`;

    // ── record the intent before sending anyone to pay ──
    const oRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        reference,
        duration_hrs: plan.duration_hrs,
        amount_ngn: plan.amount_ngn,
        email: null,
        phone: null,
        status: "pending",
      }),
    });
    if (!oRes.ok) {
      console.error("order insert failed", await oRes.text());
      return json({ error: "Could not start the payment. Try again." }, 500);
    }

    // ── hand off to Paystack (amount is in kobo) ──
    const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: guestEmail,
        amount: plan.amount_ngn * 100,
        reference,
        currency: "NGN",
        callback_url: `${SITE_URL}/home.html`,
        metadata: {
          plan: plan.label,
          duration_hrs: plan.duration_hrs,
        },
      }),
    });

    const ps = await psRes.json();
    if (!ps.status) {
      console.error("paystack init failed", ps);
      return json({ error: ps.message ?? "Payment could not be started." }, 502);
    }

    return json({
      authorization_url: ps.data.authorization_url,
      reference,
      amount_ngn: plan.amount_ngn,
      label: plan.label,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
