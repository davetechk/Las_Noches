/* Las Noches — shared front-end config.
   The anon key is safe in the browser: pricing and capacity are the only
   things it can read publicly, and orders are not readable at all.
   Never put the service_role key here. */

const CONFIG = {
  SUPABASE_URL: 'https://wemdkxuuxkiitqftgksn.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlbWRreHV1eGtpaXRxZnRna3NuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5NzUyNDMsImV4cCI6MjA5NTU1MTI0M30.BXCboszU_P6NGjglgWFuwf5NbVeaQy_4yDm6O5NyAoo',

  // WhatsApp number in international format, no + and no spaces
  WHATSAPP: '2348000000000',

  // The fixed staff account the front-desk PIN signs into.
  // Create it once in Supabase > Authentication > Users.
  // Its password IS the PIN the receptionist types.
  STAFF_EMAIL: 'lasnoches@gmail.com',
};
