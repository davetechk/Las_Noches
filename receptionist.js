// ============================================================
// Las Noches – receptionist.js
// ============================================================

let currentSession = null;   // { id, date, receptionist_name }
let currentUser   = null;

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
});

// ── Screen manager ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ── Event bindings ───────────────────────────────────────────
function bindEvents() {
  // Login
  document.getElementById('loginForm').addEventListener('submit', handleLogin);

  // Session setup
  document.getElementById('sessionForm').addEventListener('submit', handleSessionStart);
  document.getElementById('sessionDateInput').value = todayISO();

  // Entry form
  document.getElementById('entryForm').addEventListener('submit', handleEntrySubmit);

  // Time-in auto-fill
  document.getElementById('timeInInput').addEventListener('change', computeDuration);
  document.getElementById('timeOutInput').addEventListener('change', computeDuration);

  // Sign out
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

  // Receptionist has a fixed email set in Supabase; password only shown on UI
  const RECEPTIONIST_EMAIL = 'receptionist@lasnoches.com';

  const { data, error } = await db.auth.signInWithPassword({
    email: RECEPTIONIST_EMAIL,
    password,
  });

  setLoading(btn, false);

  if (error) {
    showToast('Incorrect password. Try again.', 'error');
    document.getElementById('passwordInput').value = '';
    return;
  }

  const role = data.user.user_metadata?.role;
  if (role !== 'receptionist') {
    await signOut();
    showToast('Access denied. Not a receptionist account.', 'error');
    return;
  }

  currentUser = data.user;
  document.getElementById('sessionDateInput').value = todayISO();
  showScreen('sessionSetupScreen');
}

// ── Session setup ─────────────────────────────────────────────
async function handleSessionStart(e) {
  e.preventDefault();
  const btn = document.getElementById('startSessionBtn');
  const date = document.getElementById('sessionDateInput').value;
  const name = document.getElementById('receptionistNameInput').value.trim();

  if (!date || !name) return;

  setLoading(btn, true);

  // Use .maybeSingle() instead of .single() — returns null instead of error when no row found
  const { data: existing, error: fetchError } = await db
    .from('sessions')
    .select('*')
    .eq('date', date)
    .maybeSingle();

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
      .from('sessions')
      .insert({ date, receptionist_name: name })
      .select()
      .maybeSingle();

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

  const { error } = await db.from('entries').insert({
    session_id:   currentSession.id,
    entry_date:   currentSession.date,
    voucher_code: voucher,
    seat_number:  seat,
    time_in:      timeIn,
    time_out:     timeOut,
    duration_hrs: duration ? parseFloat(duration) : null,
    amount_paid:  amount   ? parseFloat(amount)   : null,
  });

  setLoading(btn, false);

  if (error) {
    showToast('Failed to save entry: ' + error.message, 'error');
    return;
  }

  showToast('Entry saved!', 'success');
  document.getElementById('entryForm').reset();
  setTimeInNow();
  await loadTodayEntries();
}

// ── Load today's entries ──────────────────────────────────────
async function loadTodayEntries() {
  const { data, error } = await db
    .from('entries')
    .select('*')
    .eq('entry_date', currentSession.date)
    .order('created_at', { ascending: false });

  if (error) return;

  renderEntriesTable(data || []);
  document.getElementById('entryCount').textContent = (data || []).length;
}

function renderEntriesTable(entries) {
  const tbody = document.getElementById('entriesTableBody');
  const empty = document.getElementById('tableEmpty');

  if (!entries.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  tbody.innerHTML = entries.map(e => `
    <tr>
      <td><span class="badge badge-blue">${e.voucher_code}</span></td>
      <td><span class="badge badge-gold">Seat ${e.seat_number}</span></td>
      <td>${formatTime(e.time_in)}</td>
      <td>${formatTime(e.time_out)}</td>
      <td>${e.duration_hrs != null ? e.duration_hrs + 'h' : '—'}</td>
      <td>${formatAmount(e.amount_paid)}</td>
    </tr>
  `).join('');
}

// ── Duration auto-compute ─────────────────────────────────────
function computeDuration() {
  const tin  = document.getElementById('timeInInput').value;
  const tout = document.getElementById('timeOutInput').value;
  if (!tin || !tout) return;

  const [h1, m1] = tin.split(':').map(Number);
  const [h2, m2] = tout.split(':').map(Number);
  let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (diff < 0) diff += 1440; // overnight
  const hrs = (diff / 60).toFixed(2);
  document.getElementById('durationInput').value = hrs;
}

function setTimeInNow() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('timeInInput').value = `${hh}:${mm}`;
}

// ── New session / sign out ────────────────────────────────────
function handleNewSession() {
  currentSession = null;
  document.getElementById('sessionForm').reset();
  document.getElementById('sessionDateInput').value = todayISO();
  showScreen('sessionSetupScreen');
}

async function handleSignOut() {
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