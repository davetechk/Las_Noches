// supabase/functions/paystack-webhook/index.ts
//
// The ONLY place a paid voucher is issued.
//
// Paystack signs every webhook with HMAC-SHA512 of the raw body using your
// secret key. We verify that signature before trusting anything. A customer's
// browser can claim it paid; a signed webhook cannot be forged without the
// secret. This is the difference between a working system and one that gets
// drained in a week.
//
// Deploy with --no-verify-jwt (Paystack does not send a Supabase token):
//   supabase functions deploy paystack-webhook --no-verify-jwt

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const sbHeaders = {
  "Content-Type": "application/json",
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

const enc = new TextEncoder();

async function signatureOk(raw: string, header: string | null) {
  if (!header) return false;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(PAYSTACK_KEY),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  // constant-time compare
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const raw = await req.text();

  if (!(await signatureOk(raw, req.headers.get("x-paystack-signature")))) {
    console.warn("rejected: bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // Anything other than a successful charge is not our business.
  if (event.event !== "charge.success") {
    return new Response("ignored", { status: 200 });
  }

  const reference = event.data?.reference;
  const paidKobo  = event.data?.amount;
  if (!reference) return new Response("no reference", { status: 400 });

  try {
    // Confirm the amount matches what we asked for. Never trust the payload
    // alone — check it against the order we created.
    const oRes = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?reference=eq.${reference}&select=*`,
      { headers: sbHeaders },
    );
    const order = (await oRes.json())?.[0];

    if (!order) {
      console.error("unknown reference", reference);
      return new Response("unknown order", { status: 200 });
    }

    if (paidKobo !== order.amount_ngn * 100) {
      console.error(`amount mismatch on ${reference}: paid ${paidKobo}, expected ${order.amount_ngn * 100}`);
      await fetch(`${SUPABASE_URL}/rest/v1/orders?reference=eq.${reference}`, {
        method: "PATCH", headers: sbHeaders,
        body: JSON.stringify({ status: "failed" }),
      });
      return new Response("amount mismatch", { status: 200 });
    }

    // Issue it. This function is idempotent — Paystack retries webhooks, and
    // a retry must return the same voucher, not mint a second one.
    const iRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_online_entry`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ p_reference: reference }),
    });

    if (!iRes.ok) {
      const body = await iRes.text();
      console.error("issue failed", reference, body);
      // Return 200 so Paystack stops retrying a request that will keep
      // failing; the order is marked sold_out and staff can refund.
      return new Response("issue failed", { status: 200 });
    }

    const issued = await iRes.json();
    console.log("issued", reference, issued?.[0]?.voucher_code);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error(err);
    // 500 makes Paystack retry, which is what we want for a transient fault.
    return new Response("error", { status: 500 });
  }
});
