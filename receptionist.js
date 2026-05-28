// ============================================================
// Las Noches – receptionist.js
// ============================================================

let currentSession = null;
let currentUser    = null;

// Tracks active notification timers: { entryId: timeoutId }
const activeTimers = {};

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const session = await getSession();

  if (session) {
    const role = await getUserRole();
    if (role !== 'receptionist') {
      await signOut();
      showScreen('loginScreen');
      return;
    }
    currentUser = session.user;
    showScreen('sessionSetupScreen');
  } else {
    showScreen('loginScreen');
  }

  bindEvents();
  requestNotificationPermission();
});

// ── Notification permission ───────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ── Schedule a notification when a visitor's time is up ──────
function scheduleExpiryNotification(entry) {
  // Only schedule if we have time_in and duration_hrs
  if (!entry.time_in || !entry.duration_hrs) return;

  // Cancel any existing timer for this entry
  if (activeTimers[entry.id]) {
    clearTimeout(activeTimers[entry.id]);
    delete activeTimers[entry.id];
  }

  // Calculate expiry time
  const today = entry.entry_date || currentSession.date;
  const [h, m, s] = entry.time_in.split(':').map(Number);
  const expiryMs  = parseFloat(entry.duration_hrs) * 60 * 60 * 1000;

  const entryStart = new Date(`${today}T${entry.time_in}`);
  const expiryTime = new Date(entryStart.getTime() + expiryMs);
  const msUntilExpiry = expiryTime.getTime() - Date.now();

  // Don't schedule if already expired or more than 24hrs away
  if (msUntilExpiry <= 0 || msUntilExpiry > 24 * 60 * 60 * 1000) return;

  const timerId = setTimeout(() => {
    fireExpiryNotification(entry);
    delete activeTimers[entry.id];
    // Refresh table to update UI indicator
    loadTodayEntries();
  }, msUntilExpiry);

  activeTimers[entry.id] = timerId;

  const minsLeft = Math.round(msUntilExpiry / 60000);
  console.log(`Timer set for Seat ${entry.seat_number} – expires in ${minsLeft} min`);
}

function fireExpiryNotification(entry) {
  const title = `⏰ Time's Up – Seat ${entry.seat_number}`;
  const body  = `Voucher ${entry.voucher_code} · ${entry.duration_hrs}h session has ended.`;

  // Try service worker notification first (works when tab is in background)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title,
      body,
      tag: `expiry-${entry.id}`,
    });
  } else if (Notification.permission === 'granted') {
    // Fallback: direct notification
    new Notification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: `expiry-${entry.id}`,
      requireInteraction: true,
    });
  }

  // Also show in-app toast
  showToast(`⏰ Time up — Seat ${entry.seat_number} (${entry.voucher_code})`, 'warning', 8000);
}

// ── Cancel all active timers (on sign out / session change) ──
function clearAllTimers() {
  Object.values(activeTimers).forEach(id => clearTimeout(id));
  Object.keys(activeTimers).forEach(k => delete activeTimers[k]);
}

// ── Screen manager ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ── Event bindings ───────────────────────────────────────────
function bindEvents() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('sessionForm').addEventListener('submit', handleSessionStart);
  document.getElementById('sessionDateInput').value = todayISO();
  document.getElementById('entryForm').addEventListener('submit', handleEntrySubmit);
  document.getElementById('timeInInput').addEventListener('change', computeDuration);
  document.getElementById('timeOutInput').addEventListener('change', computeDuration);
  document.getElementById('signOutBtn').addEventListener('click', handleSignOut);
  document.getElementById('newSessionBtn').addEventListener('click', handleNewSession);
}

// ── Login ────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const password = document.getElementById('passwordInput').value.trim();
  if (!password) return;

  setLoading(btn, true);
  const RECEPTIONIST_EMAIL = 'receptionist@lasnoches.com';
  const { data, error } = await db.auth.signInWithPassword({ email: RECEPTIONIST_EMAIL, password });
  setLoading(btn, false);

  if (error) {
    showToast('Incorrect password. Try again.', 'error');
    document.getElementById('passwordInput').value = '';
    return;
  }

  const role = data.user.user_metadata?.role;
  if (role !== 'receptionist') {
    await signOut();
    showToast('Access denied.', 'error');
    return;
  }

  currentUser = data.user;
  document.getElementById('sessionDateInput').value = todayISO();
  showScreen('sessionSetupScreen');
}

// ── Session setup ─────────────────────────────────────────────
async function handleSessionStart(e) {
  e.preventDefault();
  const btn  = document.getElementById('startSessionBtn');
  const date = document.getElementById('sessionDateInput').value;
  const name = document.getElementById('receptionistNameInput').value.trim();
  if (!date || !name) return;

  setLoading(btn, true);

  const { data: existing, error: fetchError } = await db
    .from('sessions').select('*').eq('date', date).maybeSingle();

  if (fetchError) {
    showToast('Failed to check session: ' + fetchError.message, 'error');
    setLoading(btn, false);
    return;
  }

  if (existing) {
    currentSession = existing;
    showToast(`Resuming session for ${formatDate(date)}`, 'warning');
  } else {
    const { data, error } = await db
      .from('sessions').insert({ date, receptionist_name: name }).select().maybeSingle();
    if (error) {
      showToast('Failed to start session: ' + error.message, 'error');
      setLoading(btn, false);
      return;
    }
    currentSession = data;
    showToast(`Session started for ${formatDate(date)}`, 'success');
  }

  setLoading(btn, false);
  renderSessionBanner();
  await loadTodayEntries();
  showScreen('entryScreen');
}

// ── Session banner ────────────────────────────────────────────
function renderSessionBanner() {
  document.getElementById('sessionInfo').textContent =
    `${formatDate(currentSession.date)}  ·  ${currentSession.receptionist_name}`;
}

// ── Entry submission ──────────────────────────────────────────
async function handleEntrySubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('submitEntryBtn');

  const voucher  = document.getElementById('voucherInput').value.trim();
  const seat     = parseInt(document.getElementById('seatSelect').value);
  const timeIn   = document.getElementById('timeInInput').value;
  const timeOut  = document.getElementById('timeOutInput').value || null;
  const duration = document.getElementById('durationInput').value || null;
  const amount   = document.getElementById('amountInput').value || null;

  if (!voucher || !seat || !timeIn) {
    showToast('Voucher code, seat, and time-in are required.', 'warning');
    return;
  }

  setLoading(btn, true);

  const { data: newEntry, error } = await db.from('entries').insert({
    session_id:   currentSession.id,
    entry_date:   currentSession.date,
    voucher_code: voucher,
    seat_number:  seat,
    time_in:      timeIn,
    time_out:     timeOut,
    duration_hrs: duration ? parseFloat(duration) : null,
    amount_paid:  amount   ? parseFloat(amount)   : null,
  }).select().maybeSingle();

  setLoading(btn, false);

  if (error) {
    showToast('Failed to save entry: ' + error.message, 'error');
    return;
  }

  showToast('Entry saved!', 'success');

  // Schedule expiry notification if duration was set
  if (newEntry && newEntry.duration_hrs) {
    scheduleExpiryNotification(newEntry);

    if (Notification.permission !== 'granted') {
      showToast('Enable notifications to get time-up alerts.', 'warning', 5000);
    }
  }

  document.getElementById('entryForm').reset();
  setTimeInNow();
  await loadTodayEntries();
}

// ── Load today's entries + reschedule any still-active timers ─
async function loadTodayEntries() {
  const { data, error } = await db
    .from('entries')
    .select('*')
    .eq('entry_date', currentSession.date)
    .order('created_at', { ascending: false });

  if (error) return;

  const entries = data || [];

  // Reschedule timers for entries that haven't expired yet
  entries.forEach(e => {
    if (e.duration_hrs && !e.time_out) {
      scheduleExpiryNotification(e);
    }
  });

  renderEntriesTable(entries);
  document.getElementById('entryCount').textContent = entries.length;
}

// ── Render entries table with expiry indicator ────────────────
function renderEntriesTable(entries) {
  const tbody = document.getElementById('entriesTableBody');
  const empty = document.getElementById('tableEmpty');

  if (!entries.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  tbody.innerHTML = entries.map(e => {
    const status = getEntryStatus(e);
    return `
      <tr>
        <td><span class="badge badge-blue">${e.voucher_code}</span></td>
        <td><span class="badge badge-gold">Seat ${e.seat_number}</span></td>
        <td>${formatTime(e.time_in)}</td>
        <td>${formatTime(e.time_out)}</td>
        <td>${e.duration_hrs != null ? e.duration_hrs + 'h' : '—'}</td>
        <td>${formatAmount(e.amount_paid)}</td>
        <td>${status.html}</td>
      </tr>
    `;
  }).join('');
}

// ── Compute live entry status ─────────────────────────────────
function getEntryStatus(entry) {
  if (!entry.duration_hrs || !entry.time_in) {
    return { html: '<span class="badge" style="background:rgba(255,255,255,.06);color:var(--text-muted)">—</span>' };
  }

  const today      = entry.entry_date || currentSession?.date || todayISO();
  const start      = new Date(`${today}T${entry.time_in}`);
  const expiryMs   = parseFloat(entry.duration_hrs) * 3600000;
  const expiry     = new Date(start.getTime() + expiryMs);
  const now        = Date.now();
  const msLeft     = expiry.getTime() - now;

  if (msLeft <= 0) {
    return { html: '<span class="badge" style="background:rgba(224,92,92,.15);color:#e05c5c;border:1px solid rgba(224,92,92,.3)">Expired</span>' };
  }

  const minsLeft = Math.round(msLeft / 60000);

  if (minsLeft <= 15) {
    return { html: `<span class="badge" style="background:rgba(224,164,78,.15);color:#e0a44e;border:1px solid rgba(224,164,78,.3)">⚠ ${minsLeft}m left</span>` };
  }

  const hLeft = Math.floor(minsLeft / 60);
  const mLeft = minsLeft % 60;
  const label = hLeft > 0 ? `${hLeft}h ${mLeft}m` : `${mLeft}m`;
  return { html: `<span class="badge badge-green">${label} left</span>` };
}

// ── Duration auto-compute ─────────────────────────────────────
function computeDuration() {
  const tin  = document.getElementById('timeInInput').value;
  const tout = document.getElementById('timeOutInput').value;
  if (!tin || !tout) return;

  const [h1, m1] = tin.split(':').map(Number);
  const [h2, m2] = tout.split(':').map(Number);
  let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diff < 0) diff += 1440;
  document.getElementById('durationInput').value = (diff / 60).toFixed(2);
}

function setTimeInNow() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('timeInInput').value = `${hh}:${mm}`;
}

// ── New session / sign out ────────────────────────────────────
function handleNewSession() {
  clearAllTimers();
  currentSession = null;
  document.getElementById('sessionForm').reset();
  document.getElementById('sessionDateInput').value = todayISO();
  showScreen('sessionSetupScreen');
}

async function handleSignOut() {
  clearAllTimers();
  await signOut();
  currentSession = null;
  currentUser    = null;
  document.getElementById('passwordInput').value = '';
  showScreen('loginScreen');
}

// ── Utility ──────────────────────────────────────────────────
function setLoading(btn, loading) {
  btn.disabled = loading;
  if (loading) {
    btn._original = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Please wait…';
  } else {
    btn.innerHTML = btn._original || btn.innerHTML;
  }
}

// ── Refresh status badges every minute ───────────────────────
setInterval(() => {
  if (currentSession) loadTodayEntries();
}, 60000);
