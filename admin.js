// ============================================================
// Las Noches – admin.js
// ============================================================

let currentAdminUser = null;
let allDates = [];          // all distinct entry dates from DB
let currentViewDate = null; // currently displayed date
let currentEntries  = [];   // currently displayed entries
let currentSession  = null; // session meta for current date

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const session = await getSession();

  if (session) {
    const role = await getUserRole();
    if (role !== 'admin') {
      await signOut();
      showAdminScreen('adminLoginScreen');
      return;
    }
    currentAdminUser = session.user;
    await initDashboard();
  } else {
    showAdminScreen('adminLoginScreen');
  }

  bindAdminEvents();
});

// ── Screen manager ────────────────────────────────────────────
function showAdminScreen(id) {
  document.querySelectorAll('.a-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ── Event bindings ────────────────────────────────────────────
function bindAdminEvents() {
  document.getElementById('adminLoginForm').addEventListener('submit', handleAdminLogin);
  document.getElementById('adminSignOutBtn').addEventListener('click', handleAdminSignOut);
  document.getElementById('dateDropdown').addEventListener('change', handleDateDropdownChange);

  // Download controls
  document.getElementById('downloadPdfBtn').addEventListener('click', () => triggerDownload('pdf'));
  document.getElementById('downloadCsvBtn').addEventListener('click', () => triggerDownload('csv'));

  // Tab buttons: today / yesterday / custom days
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', handleTabClick);
  });

  // Custom days input download
  document.getElementById('customDaysDownloadBtn').addEventListener('click', handleCustomDaysDownload);
}

// ── Admin login ───────────────────────────────────────────────
async function handleAdminLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('adminLoginBtn');
  const email    = document.getElementById('adminEmailInput').value.trim();
  const password = document.getElementById('adminPasswordInput').value;

  if (!email || !password) return;

  setLoadingAdmin(btn, true);

  const { data, error } = await db.auth.signInWithPassword({ email, password });

  setLoadingAdmin(btn, false);

  if (error) {
    showToast('Login failed: ' + error.message, 'error');
    return;
  }

  const role = data.user.user_metadata?.role;
  if (role !== 'admin') {
    await signOut();
    showToast('Access denied. Not an admin account.', 'error');
    return;
  }

  currentAdminUser = data.user;
  await initDashboard();
}

async function handleAdminSignOut() {
  await signOut();
  currentAdminUser = null;
  showAdminScreen('adminLoginScreen');
}

// ── Dashboard init ────────────────────────────────────────────
async function initDashboard() {
  showAdminScreen('adminDashboardScreen');
  document.getElementById('adminUserLabel').textContent = currentAdminUser.email;

  await loadAllDates();
  await loadStats();

  // Default: show today if has entries, else most recent date
  const today = todayISO();
  const defaultDate = allDates.includes(today) ? today : (allDates[0] || today);
  await displayEntriesForDate(defaultDate);
  syncDropdown(defaultDate);
}

// ── Load all distinct dates from DB ──────────────────────────
async function loadAllDates() {
  const { data, error } = await db
    .from('entries')
    .select('entry_date')
    .order('entry_date', { ascending: false });

  if (error || !data) return;

  // Unique dates
  const seen = new Set();
  allDates = data
    .map(r => r.entry_date)
    .filter(d => { if (seen.has(d)) return false; seen.add(d); return true; });

  populateDateDropdown();
}

function populateDateDropdown() {
  const sel = document.getElementById('dateDropdown');
  sel.innerHTML = '<option value="">— Pick a date —</option>';
  allDates.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = formatDate(d);
    sel.appendChild(opt);
  });
}

function syncDropdown(dateStr) {
  document.getElementById('dateDropdown').value = dateStr || '';
}

// ── Load summary stats ────────────────────────────────────────
async function loadStats() {
  const today = todayISO();

  // Today count
  const { count: todayCount } = await db
    .from('entries')
    .select('*', { count: 'exact', head: true })
    .eq('entry_date', today);

  // Total all time
  const { count: totalCount } = await db
    .from('entries')
    .select('*', { count: 'exact', head: true });

  // Total revenue today
  const { data: todayRev } = await db
    .from('entries')
    .select('amount_paid')
    .eq('entry_date', today);

  const revenue = (todayRev || []).reduce((sum, r) => sum + (parseFloat(r.amount_paid) || 0), 0);

  document.getElementById('statToday').textContent  = todayCount || 0;
  document.getElementById('statTotal').textContent  = totalCount || 0;
  document.getElementById('statRevenue').textContent = '₦' + revenue.toLocaleString('en-NG', { minimumFractionDigits: 2 });
  document.getElementById('statDates').textContent  = allDates.length;
}

// ── Display entries for a specific date ───────────────────────
async function displayEntriesForDate(dateStr) {
  if (!dateStr) return;
  currentViewDate = dateStr;

  // Get session info
  const { data: sessionData } = await db
    .from('sessions')
    .select('*')
    .eq('date', dateStr)
    .single();

  currentSession = sessionData;

  // Get entries
  const { data: entries, error } = await db
    .from('entries')
    .select('*')
    .eq('entry_date', dateStr)
    .order('time_in', { ascending: true });

  if (error) {
    showToast('Failed to load entries: ' + error.message, 'error');
    return;
  }

  currentEntries = entries || [];
  renderAdminTable(currentEntries);
  renderDateHeading(dateStr, sessionData);
  updateDownloadInfo(dateStr);
}

function renderDateHeading(dateStr, session) {
  const heading = document.getElementById('viewingDateLabel');
  const sub     = document.getElementById('viewingDateSub');
  const counter = document.getElementById('adminCustomerCount');

  heading.textContent = formatDate(dateStr);

  const count = currentEntries.length;
  if (counter) counter.textContent = count;

  if (session) {
    sub.textContent = `Logged by ${session.receptionist_name}  ·  ${count} customer${count === 1 ? '' : 's'}`;
  } else {
    sub.textContent = `${count} customer${count === 1 ? '' : 's'}`;
  }
}

function updateDownloadInfo(dateStr) {
  document.getElementById('downloadDateLabel').textContent = formatDate(dateStr);
}

// ── Render admin table ────────────────────────────────────────
function renderAdminTable(entries) {
  const tbody = document.getElementById('adminTableBody');
  const empty = document.getElementById('adminTableEmpty');

  if (!entries.length) {
    tbody.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  const totalRev = entries.reduce((s, e) => s + (parseFloat(e.amount_paid) || 0), 0);

  tbody.innerHTML = entries.map((e, i) => `
    <tr>
      <td style="color:var(--text-muted);font-size:.8rem">${i + 1}</td>
      <td><span class="badge badge-blue">${e.voucher_code}</span></td>
      <td><span class="badge badge-gold">Seat ${e.seat_number}</span></td>
      <td>${formatTime(e.time_in)}</td>
      <td>${formatTime(e.time_out)}</td>
      <td>${e.duration_hrs != null ? e.duration_hrs + 'h' : '—'}</td>
      <td class="text-success fw-500">${formatAmount(e.amount_paid)}</td>
    </tr>
  `).join('') + `
    <tr style="border-top:1px solid var(--border)">
      <td colspan="6" style="text-align:right;color:var(--text-muted);font-size:.8rem;padding:.75rem 1rem;letter-spacing:.05em;text-transform:uppercase">Total Revenue</td>
      <td class="text-gold fw-600" style="padding:.75rem 1rem">₦${totalRev.toLocaleString('en-NG',{minimumFractionDigits:2})}</td>
    </tr>
  `;
}

// ── Date dropdown change ──────────────────────────────────────
async function handleDateDropdownChange(e) {
  const val = e.target.value;
  if (!val) return;
  await displayEntriesForDate(val);
}

// ── Tab buttons ───────────────────────────────────────────────
async function handleTabClick(e) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  e.currentTarget.classList.add('active');

  const range = e.currentTarget.dataset.range;
  const today = todayISO();

  if (range === 'today') {
    await displayEntriesForDate(today);
    syncDropdown(today);
  } else if (range === 'yesterday') {
    const yesterday = subtractDays(today, 1);
    await displayEntriesForDate(yesterday);
    syncDropdown(yesterday);
  }
}

// ── Custom days download ──────────────────────────────────────
async function handleCustomDaysDownload() {
  const days  = parseInt(document.getElementById('customDaysInput').value);
  const fmt   = document.querySelector('input[name="dlFormat"]:checked')?.value || 'csv';

  if (!days || days < 1) {
    showToast('Enter a valid number of days.', 'warning');
    return;
  }

  const today = todayISO();
  const from  = subtractDays(today, days - 1);

  const { data: entries, error } = await db
    .from('entries')
    .select('*, sessions(receptionist_name)')
    .gte('entry_date', from)
    .lte('entry_date', today)
    .order('entry_date', { ascending: true })
    .order('time_in',   { ascending: true });

  if (error) { showToast('Failed to fetch entries.', 'error'); return; }

  const label = `Last_${days}_Days`;
  if (fmt === 'pdf') exportPDF(entries || [], label);
  else               exportCSV(entries || [], label);
}

// ── Download current view ─────────────────────────────────────
async function triggerDownload(format) {
  if (!currentViewDate) { showToast('Select a date first.', 'warning'); return; }

  const label = currentViewDate.replace(/-/g, '');
  if (format === 'pdf') exportPDF(currentEntries, `Entries_${label}`, currentViewDate, currentSession);
  else                  exportCSV(currentEntries, `Entries_${label}`, currentViewDate, currentSession);
}

// ── CSV Export ────────────────────────────────────────────────
function exportCSV(entries, filename, dateStr, session) {
  const receptionist = session?.receptionist_name || '';
  const dateLabel    = dateStr ? formatDate(dateStr) : 'Multiple Dates';

  const header = ['#', 'Date', 'Receptionist', 'Voucher Code', 'Seat', 'Time In', 'Time Out', 'Duration (hrs)', 'Amount Paid (₦)'];

  const rows = entries.map((e, i) => [
    i + 1,
    e.entry_date || dateStr,
    e.sessions?.receptionist_name || receptionist,
    e.voucher_code,
    `Seat ${e.seat_number}`,
    e.time_in   || '',
    e.time_out  || '',
    e.duration_hrs != null ? e.duration_hrs : '',
    e.amount_paid  != null ? parseFloat(e.amount_paid).toFixed(2) : '',
  ]);

  const csvContent = [
    ['Las Noches – Entries Export'],
    [`Date: ${dateLabel}`],
    [],
    header,
    ...rows,
    [],
    ['Total Customers', entries.length],
    ['Total Revenue', '', '', '', '', '', '', '', entries.reduce((s,e) => s + (parseFloat(e.amount_paid)||0), 0).toFixed(2)],
  ].map(row => row.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\n');

  downloadBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `${filename}.csv`);
  showToast('CSV downloaded.', 'success');
}

// ── PDF Export (pure JS, no library) ─────────────────────────
function exportPDF(entries, filename, dateStr, session) {
  const receptionist = session?.receptionist_name || (entries[0]?.sessions?.receptionist_name || '');
  const dateLabel    = dateStr ? formatDate(dateStr) : 'Multiple Dates';
  const totalRev     = entries.reduce((s, e) => s + (parseFloat(e.amount_paid) || 0), 0);

  const rows = entries.map((e, i) => `
    <tr class="${i % 2 === 0 ? 'even' : ''}">
      <td>${i + 1}</td>
      <td>${e.entry_date || dateStr || ''}</td>
      <td>${e.sessions?.receptionist_name || receptionist}</td>
      <td><strong>${e.voucher_code}</strong></td>
      <td>Seat ${e.seat_number}</td>
      <td>${formatTime(e.time_in)}</td>
      <td>${formatTime(e.time_out)}</td>
      <td>${e.duration_hrs != null ? e.duration_hrs + 'h' : '—'}</td>
      <td>₦${e.amount_paid != null ? parseFloat(e.amount_paid).toLocaleString('en-NG',{minimumFractionDigits:2}) : '—'}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Las Noches – ${dateLabel}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; background: #fff; color: #1a1a2e; font-size: 12px; padding: 32px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 2px solid #0f2040; }
  .header h1 { font-size: 22px; font-weight: 600; color: #0a1628; letter-spacing: .02em; }
  .header .sub { font-size: 11px; color: #6b7c99; margin-top: 4px; }
  .meta { text-align: right; font-size: 11px; color: #6b7c99; line-height: 1.8; }
  .meta strong { color: #0a1628; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  thead th { background: #0f2040; color: #c4d9f5; padding: 8px 10px; text-align: left; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
  tbody td { padding: 7px 10px; border-bottom: 1px solid #e8edf5; vertical-align: middle; }
  tbody tr.even td { background: #f7f9fc; }
  tbody tr:last-child td { border-bottom: none; }
  .total-row td { background: #0a1628 !important; color: #e0c87a; font-weight: 600; padding: 9px 10px; }
  .footer { margin-top: 24px; font-size: 10px; color: #9aabbf; text-align: center; }
  @media print { body { padding: 16px; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Las Noches</h1>
      <div class="sub">Visitor Entry Report</div>
    </div>
    <div class="meta">
      <div><strong>Date:</strong> ${dateLabel}</div>
      ${receptionist ? `<div><strong>Receptionist:</strong> ${receptionist}</div>` : ''}
      <div><strong>Total Entries:</strong> ${entries.length}</div>
      <div><strong>Generated:</strong> ${new Date().toLocaleString('en-GB')}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th><th>Date</th><th>By</th><th>Voucher</th><th>Seat</th>
        <th>Time In</th><th>Time Out</th><th>Duration</th><th>Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="9" style="text-align:center;padding:20px;color:#9aabbf">No entries found.</td></tr>'}
      <tr class="total-row">
        <td colspan="8" style="text-align:right;letter-spacing:.06em;font-size:10px">TOTAL REVENUE</td>
        <td>₦${totalRev.toLocaleString('en-NG', {minimumFractionDigits:2})}</td>
      </tr>
    </tbody>
  </table>

  <div class="footer">Las Noches · Confidential · Generated ${new Date().toLocaleDateString('en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
</body>
</html>`;

  // Open in new window and print
  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 600);
  showToast('PDF ready to print/save.', 'success');
}

// ── Blob download helper ──────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Utility ──────────────────────────────────────────────────
function setLoadingAdmin(btn, loading) {
  btn.disabled = loading;
  if (loading) {
    btn._original = btn.innerHTML;
    btn.innerHTML = 'Signing in…';
  } else {
    btn.innerHTML = btn._original || btn.innerHTML;
  }
}