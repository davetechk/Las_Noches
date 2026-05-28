// ============================================================
// Las Noches – app.js
// Shared Supabase client + auth utilities
// ============================================================

// ── CONFIG: Replace with your Supabase project details ──────
const SUPABASE_URL = 'https://wemdkxuuxkiitqftgksn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlbWRreHV1eGtpaXRxZnRna3NuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5NzUyNDMsImV4cCI6MjA5NTU1MTI0M30.BXCboszU_P6NGjglgWFuwf5NbVeaQy_4yDm6O5NyAoo';
// ────────────────────────────────────────────────────────────

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Toast notifications ──────────────────────────────────────
function showToast(message, type = 'success', duration = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = { success: '✓', error: '✕', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span style="font-size:1rem">${icons[type] || '•'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity .3s, transform .3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Auth helpers ─────────────────────────────────────────────
async function getSession() {
  const { data } = await db.auth.getSession();
  return data.session;
}

async function getUserRole() {
  const session = await getSession();
  if (!session) return null;
  return session.user.user_metadata?.role || null;
}

async function signOut() {
  await db.auth.signOut();
}

// ── Date helpers ─────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '—';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 || 12;
  return `${display}:${m} ${ampm}`;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// ── Currency formatter ───────────────────────────────────────
function formatAmount(val) {
  if (val == null || val === '') return '—';
  return '₦' + parseFloat(val).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}
