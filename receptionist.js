// ============================================================
// Las Noches – receptionist.js  (v2 – Omada Integration)
// ============================================================
//
// Changes from v1:
//  • Voucher field replaced with a searchable <select> dropdown
//    populated from `omada_vouchers` (status = 'unused').
//  • Omada sync engine: polls the Edge Function every 60 s
//    (auto-sync) AND exposes a manual "Sync Sessions" button.
//  • On sync, active vouchers get their time_in / time_out
//    written back to Supabase automatically.
//  • All original functionality (seat, amount, notifications,
//    session management) is fully preserved.
// ============================================================

let currentSession = null;
let currentUser    = null;

// Tracks active notification timers: { entryId: timeoutId }
const activeTimers = {};

// Auto-sync interval handle
let syncIntervalId = null;

// Local cache of unused vouchers for the dropdown
let unusedVouchers = [];

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
  if (!entry.time_in || !entry.duration_hrs) return;

  if (activeTimers[entry.id]) {
    clearTimeout(activeTimers[entry.id]);
    delete activeTimers[entry.id];
  }

  const today    = entry.entry_date || currentSession.date;
  const expiryMs = parseFloat(entry.duration_hrs) * 60 * 60 * 1000;

  const entryStart    = new Date(`${today}T${entry.time_in}`);
  const expiryTime    = new Date(entryStart.getTime() + expiryMs);
  const msUntilExpiry = expiryTime.getTime() - Date.now();

  if (msUntilExpiry <= 0 || msUntilExpiry > 24 * 60 * 60 * 1000) return;

  const timerId = setTimeout(() => {
    fireExpiryNotification(entry);
    delete activeTimers[entry.id];
    loadTodayEntries();
  }, msUntilExpiry);

  activeTimers[entry.id] = timerId;

  const minsLeft = Math.round(msUntilExpiry / 60000);
  console.log(`Timer set for Seat ${entry.seat_number} – expires in ${minsLeft} min`);
}

function fireExpiryNotification(entry) {
  const title = `⏰ Time's Up – Seat ${entry.seat_number}`;
  const body  = `Voucher ${entry.voucher_code} · ${entry.duration_hrs}h session has ended.`;

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title,
      body,
      tag: `expiry-${entry.id}`,
    });
  } else if (Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: `expiry-${entry.id}`,
      requireInteraction: true,
    });
  }

  showToast(`⏰ Time up — Seat ${entry.seat_number} (${entry.voucher_code})`, 'warning', 8000);
}

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

  // Omada sync button
  const syncBtn = document.getElementById('syncOmadaBtn');
  if (syncBtn) syncBtn.addEventListener('click', () => runOmadaSync(true));

  // Voucher select: live-filter via a text search box
  const voucherSearch = document.getElementById('voucherSearch');
  if (voucherSearch) voucherSearch.addEventListener('input', filterVoucherDropdown);
}

// ── Login ────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn      = document.getElementById('loginBtn');
  const password = document.getElementById('passwordInput').value.trim();
  if (!password) return;

  setLoading(btn, true);
  const RECEPTIONIST_EMAIL = 'recep@gmail.com';
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

  // Load unused vouchers for dropdown, then today's entries
  await loadUnusedVouchers();
  await loadTodayEntries();

  // Start auto-sync with Omada (every 60 s)
  startAutoSync();

  showScreen('entryScreen');
}

// ── Session banner ────────────────────────────────────────────
function renderSessionBanner() {
  document.getElementById('sessionInfo').textContent =
    `${formatDate(currentSession.date)}  ·  ${currentSession.receptionist_name}`;
}

// ════════════════════════════════════════════════════════════
// OMADA VOUCHER DROPDOWN
// ════════════════════════════════════════════════════════════

// Fetch all unused vouchers from Supabase and populate the
// <select id="voucherSelect"> element.
async function loadUnusedVouchers() {
  const { data, error } = await db
    .from('omada_vouchers')
    .select('id, voucher_code, duration')
    .eq('status', 'unused')
    .order('voucher_code', { ascending: true });

  if (error) {
    showToast('Failed to load vouchers: ' + error.message, 'error');
    return;
  }

  unusedVouchers = data || [];
  renderVoucherDropdown(unusedVouchers);
  updateVoucherCount(unusedVouchers.length);
}

// Render the <select> with the current voucher list
function renderVoucherDropdown(vouchers) {
  const sel = document.getElementById('voucherSelect');
  if (!sel) return;

  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select voucher —</option>';

  vouchers.forEach(v => {
    const opt = document.createElement('option');
    opt.value       = v.voucher_code;
    opt.dataset.id  = v.id;
    opt.textContent = `${v.voucher_code}${v.duration ? '  ·  ' + v.duration + ' min' : ''}`;
    sel.appendChild(opt);
  });

  // Re-select previous value if still available
  if (prev) sel.value = prev;

  // When a voucher is selected, auto-fill duration field if known
  sel.onchange = () => {
    const chosen = vouchers.find(v => v.voucher_code === sel.value);
    if (chosen?.duration) {
      const durationHrs = (chosen.duration / 60).toFixed(2);
      const durInput = document.getElementById('durationInput');
      if (durInput) {
        durInput.readOnly = false;
        durInput.value = durationHrs;
        durInput.readOnly = true;
      }
    }
  };
}

// Live-filter the dropdown via the search box
function filterVoucherDropdown() {
  const query    = (document.getElementById('voucherSearch')?.value || '').toLowerCase();
  const filtered = unusedVouchers.filter(v =>
    v.voucher_code.toLowerCase().includes(query)
  );
  renderVoucherDropdown(filtered);
}

// Update the "N vouchers available" pill
function updateVoucherCount(count) {
  const el = document.getElementById('voucherAvailableCount');
  if (el) el.textContent = count;
}

// ════════════════════════════════════════════════════════════
// OMADA SYNC ENGINE
// ════════════════════════════════════════════════════════════

// Start polling every 60 seconds
function startAutoSync() {
  stopAutoSync(); // clear any existing interval
  // Run once immediately on session start
  runOmadaSync(false);
  syncIntervalId = setInterval(() => runOmadaSync(false), 60000);
  console.log('[OmadaSync] Auto-sync started (60s interval)');
}

function stopAutoSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

// Core sync function. Pass showFeedback=true for manual trigger.
async function runOmadaSync(showFeedback = false) {
  const syncBtn = document.getElementById('syncOmadaBtn');
  const syncDot = document.getElementById('syncStatusDot');

  // Update UI state
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn._original = syncBtn.innerHTML;
    syncBtn.innerHTML = '<span class="spinner"></span> Syncing…';
  }
  if (syncDot) syncDot.className = 'sync-dot syncing';

  try {
    // ── Call the Supabase Edge Function ──────────────────
    const { data: { session } } = await db.auth.getSession();
    const authHeader = session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : {};

    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/omada-sync`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({}), // no filter = sync all vouchers
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Edge Function returned ${res.status}: ${errBody}`);
    }

    const result = await res.json();

    if (!result.success) {
      throw new Error(result.error || 'Unknown sync error');
    }

    // ── Update dropdown directly from sync response ────────
    // The Edge Function returns unused_vouchers so we don't
    // need a separate DB query to refresh the dropdown.
    if (Array.isArray(result.unused_vouchers)) {
      unusedVouchers = result.unused_vouchers;
      renderVoucherDropdown(unusedVouchers);
      updateVoucherCount(unusedVouchers.length);
    } else {
      await loadUnusedVouchers();
    }

    await loadTodayEntries();

    // Update sync timestamp
    updateSyncTimestamp(new Date());
    if (syncDot) syncDot.className = 'sync-dot synced';

    if (showFeedback) {
      showToast(
        `Synced ${result.records_updated ?? 0} voucher(s) from Omada.`,
        'success'
      );
    }

    console.log('[OmadaSync] Complete:', result);

  } catch (err) {
    console.error('[OmadaSync] Error:', err.message);
    if (syncDot) syncDot.className = 'sync-dot error';
    if (showFeedback) {
      showToast('Omada sync failed: ' + err.message, 'error');
    }
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = syncBtn._original || '↻ Sync';
    }
  }
}

// Apply Omada sync data to entries table in Supabase
// This updates time_in / time_out on entries rows that match
// the voucher code, if the Omada record shows activation.
async function applyOmadaSyncResults(vouchers) {
  for (const v of vouchers) {
    // Only process vouchers that have activation data
    if (!v.time_in) continue;

    // Find the matching entry in today's log (by voucher_code)
    const { data: matchingEntries } = await db
      .from('entries')
      .select('id, time_in, time_out, duration_hrs')
      .eq('entry_date', currentSession.date)
      .eq('voucher_code', v.voucher_code);

    if (!matchingEntries || matchingEntries.length === 0) continue;

    const entry = matchingEntries[0];

    // Build the update payload — only overwrite empty fields
    const updates = {};

    if (!entry.time_in && v.time_in) {
      // Convert ISO timestamp to HH:MM for the time_in column
      const dt = new Date(v.time_in);
      updates.time_in = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
    }

    if (!entry.time_out && v.time_out) {
      const dt = new Date(v.time_out);
      updates.time_out = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
    }

    if (!entry.duration_hrs && v.duration_minutes) {
      updates.duration_hrs = parseFloat((v.duration_minutes / 60).toFixed(2));
    }

    if (Object.keys(updates).length === 0) continue;

    const { error } = await db
      .from('entries')
      .update(updates)
      .eq('id', entry.id);

    if (error) {
      console.warn(`[OmadaSync] Failed to update entry ${entry.id}:`, error.message);
    } else {
      console.log(`[OmadaSync] Updated entry for voucher ${v.voucher_code}`, updates);
    }
  }
}

// Display last-synced timestamp in the topbar
function updateSyncTimestamp(date) {
  const el = document.getElementById('lastSyncTime');
  if (!el) return;
  const t = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last sync: ${t}`;
}

// ── Entry submission ──────────────────────────────────────────
async function handleEntrySubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('submitEntryBtn');

  const voucher  = document.getElementById('voucherSelect').value.trim();
  const seat     = parseInt(document.getElementById('seatSelect').value);
  const timeIn   = document.getElementById('timeInInput').value;
  const timeOut  = document.getElementById('timeOutInput').value || null;
  const duration = document.getElementById('durationInput').value || null;
  const amount   = document.getElementById('amountInput').value || null;

  if (!voucher || !seat || !timeIn) {
    showToast('Voucher, seat, and time-in are required.', 'warning');
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

  if (error) {
    setLoading(btn, false);
    showToast('Failed to save entry: ' + error.message, 'error');
    return;
  }

  // Mark voucher as active in omada_vouchers
  await db
    .from('omada_vouchers')
    .update({ status: 'active', time_in: new Date().toISOString() })
    .eq('voucher_code', voucher);

  setLoading(btn, false);
  showToast('Entry saved!', 'success');

  if (newEntry?.duration_hrs) {
    scheduleExpiryNotification(newEntry);
    if (Notification.permission !== 'granted') {
      showToast('Enable notifications to get time-up alerts.', 'warning', 5000);
    }
  }

  document.getElementById('entryForm').reset();
  setTimeInNow();

  // Reload voucher list (selected voucher is now active)
  await loadUnusedVouchers();
  await loadTodayEntries();
}

// ── Load today's entries + reschedule active timers ──────────
async function loadTodayEntries() {
  const { data, error } = await db
    .from('entries')
    .select('*')
    .eq('entry_date', currentSession.date)
    .order('created_at', { ascending: false });

  if (error) return;

  const entries = data || [];

  entries.forEach(e => {
    if (e.duration_hrs && !e.time_out) {
      scheduleExpiryNotification(e);
    }
  });

  renderEntriesTable(entries);

  const count = entries.length;
  document.getElementById('entryCount').textContent = count;
  const bigCount = document.getElementById('customerCountBig');
  if (bigCount) bigCount.textContent = count;
}

// ── Render entries table ─────────────────────────────────────
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

  const today    = entry.entry_date || currentSession?.date || todayISO();
  const start    = new Date(`${today}T${entry.time_in}`);
  const expiry   = new Date(start.getTime() + parseFloat(entry.duration_hrs) * 3600000);
  const msLeft   = expiry.getTime() - Date.now();

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

  const durInput = document.getElementById('durationInput');
  durInput.readOnly = false;
  durInput.value = (diff / 60).toFixed(2);
  durInput.readOnly = true;
}

function setTimeInNow() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('timeInInput').value = `${hh}:${mm}`;
}

// ── New session / sign out ────────────────────────────────────
function handleNewSession() {
  stopAutoSync();
  clearAllTimers();
  currentSession = null;
  unusedVouchers = [];
  document.getElementById('sessionForm').reset();
  document.getElementById('sessionDateInput').value = todayISO();
  showScreen('sessionSetupScreen');
}

async function handleSignOut() {
  stopAutoSync();
  clearAllTimers();
  await signOut();
  currentSession = null;
  currentUser    = null;
  unusedVouchers = [];
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