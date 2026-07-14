import { watchAuth, signUp, logIn, logOut } from "./auth.js";
import * as Data from "./data.js";
import { NOTIFY_WEBHOOK_URL } from "./notify-config.js";

const appEl = document.getElementById("app");

let currentUser = null;
let authReady = false;
const minyanCache = {};
const shulCache = {};

// Fire-and-forget POST to the Apps Script Web App (see js/notify-config.js).
// Only called for brand-new RSVPs, never for un-RSVPing.
async function notifyNewRsvp(minyan, shul, userName) {
  if (!NOTIFY_WEBHOOK_URL || !shul) return;
  try {
    const adminEmails = await Data.getNotifyEmailsForShul(shul);
    if (!adminEmails.length) return;
    await fetch(NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        shulName: shul.name,
        minyanName: minyan.name,
        place: minyan.place || "",
        userName,
        adminEmails
      })
    });
  } catch (err) {
    console.warn("RSVP notification webhook failed", err);
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---- Guest identity (for shuls that allow RSVPing without an account) ----

function getGuestId() {
  let id = localStorage.getItem("minyanGuestId");
  if (!id) {
    id = "g_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("minyanGuestId", id);
  }
  return id;
}

function getSavedGuestName() {
  return localStorage.getItem("minyanGuestName") || "";
}

function myIdentity(guestName) {
  if (currentUser) return { uid: currentUser.uid, userName: currentUser.displayName || currentUser.email };
  return { guestId: getGuestId(), userName: guestName };
}

// ---- Routing ----

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return hash.split("/").filter(Boolean);
}

window.addEventListener("hashchange", render);
document.addEventListener("DOMContentLoaded", () => {
  appEl.innerHTML = navbar() + `<div class="container py-5 text-center text-muted">Loading…</div>`;
});

watchAuth(user => {
  currentUser = user;
  authReady = true;
  render();
});

async function render() {
  if (!authReady) return;
  const route = currentRoute();
  let content;
  try {
    if (route[0] === "login") {
      content = currentUser ? await viewDashboard() : viewAuth();
      if (currentUser) location.hash = "#/dashboard";
    } else if (route[0] === "dashboard") {
      content = currentUser ? await viewDashboard() : viewAuth();
    } else if (route[0] === "shul" && route[1]) {
      content = currentUser ? await viewShul(route[1]) : viewAuth();
    } else if (route[0] === "s" && route[1]) {
      content = await viewPublicShul(route[1]);
    } else {
      content = await viewHome();
    }
  } catch (err) {
    console.error(err);
    content = `<div class="container"><div class="alert alert-danger">Something went wrong loading this page. Please try again.</div></div>`;
  }
  appEl.innerHTML = navbar() + content;
  wireEvents(route);
}

// ---- Navbar ----

function navbar() {
  return `
  <nav class="topbar mb-4">
    <div class="container topbar-inner">
      <a class="navbar-brand" href="#/"><i class="bi bi-calendar-check me-1"></i>Minyan Times</a>
      <div class="topbar-actions">
        <a href="#/" class="btn btn-sm btn-outline-secondary">Home</a>
        ${currentUser ? `
          <a href="#/dashboard" class="btn btn-sm btn-outline-secondary">My Shuls</a>
          <span class="topbar-user text-muted small">${escapeHtml(currentUser.displayName || currentUser.email)}</span>
          <button id="logoutBtn" class="btn btn-sm btn-outline-danger">Logout</button>
        ` : `
          <a href="#/login" class="btn btn-sm btn-primary">Log In / Sign Up</a>
        `}
      </div>
    </div>
  </nav>`;
}

// ---- Auth view ----

function viewAuth() {
  return `
  <div class="container">
    <div class="row justify-content-center">
      <div class="col-xs-12 col-sm-8 col-md-5">
        <div class="card shadow-sm border-0">
          <div class="card-body p-4">
            <ul class="nav nav-tabs mb-3">
              <li class="nav-item active"><button type="button" class="nav-link active" data-tab="login">Log In</button></li>
              <li class="nav-item"><button type="button" class="nav-link" data-tab="signup">Sign Up</button></li>
            </ul>
            <div id="authError" class="alert alert-danger d-none"></div>
            <form id="loginForm">
              <div class="mb-3">
                <label class="form-label">Email</label>
                <input type="email" class="form-control" name="email" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" class="form-control" name="password" required>
              </div>
              <button class="btn btn-primary w-100" type="submit">Log In</button>
            </form>
            <form id="signupForm" class="d-none">
              <div class="mb-3">
                <label class="form-label">Full Name</label>
                <input type="text" class="form-control" name="name" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Email</label>
                <input type="email" class="form-control" name="email" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" class="form-control" name="password" minlength="6" required>
              </div>
              <button class="btn btn-primary w-100" type="submit">Create Account</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function friendlyAuthError(err) {
  const code = err.code || "";
  if (code.includes("email-already-in-use")) return "That email is already registered.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Incorrect email or password.";
  if (code.includes("weak-password")) return "Password should be at least 6 characters.";
  if (code.includes("invalid-email")) return "That email address looks invalid.";
  return err.message || "Something went wrong.";
}

// ---- Home (public) view ----

async function viewHome() {
  const [allShuls, minyanim] = await Promise.all([Data.getAllShuls(), Data.getAllMinyanim()]);
  minyanim.forEach(m => { minyanCache[m.id] = m; });
  allShuls.forEach(s => { shulCache[s.id] = s; });
  const shulMap = Object.fromEntries(allShuls.map(s => [s.id, s]));

  // Shuls the owner has hidden from the homepage are only reachable via
  // their direct public link (#/s/{id}) — everything below excludes them.
  const shuls = allShuls.filter(s => !s.unlisted);
  const visibleShulIds = new Set(shuls.map(s => s.id));

  const todays = minyanim.filter(m => visibleShulIds.has(m.shulId) && Data.isMinyanActiveToday(m));
  const todaysCards = await Promise.all(todays.map(m => renderMinyanCard(m, shulMap[m.shulId])));

  const byShul = {};
  minyanim.forEach(m => { (byShul[m.shulId] = byShul[m.shulId] || []).push(m); });

  const allHtml = shuls.length ? shuls.map(s => `
    <div class="mb-4">
      <h6 class="text-muted mb-2">${escapeHtml(s.name)}${s.address ? ` <span class="fw-normal">— ${escapeHtml(s.address)}</span>` : ""}</h6>
      <div class="list-group">
        ${(byShul[s.id] || []).map(m => `
          <div class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <div class="fw-semibold">${escapeHtml(m.name)}</div>
              <div class="small text-muted">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
            </div>
            ${Data.isMinyanActiveToday(m) ? '<span class="badge bg-success-subtle text-success">Today</span>' : ""}
          </div>
        `).join("") || '<div class="list-group-item text-muted">No minyanim yet.</div>'}
      </div>
    </div>
  `).join("") : `<p class="text-muted">No shuls yet. <a href="#/login">Sign up</a> to add yours!</p>`;

  return `
  <div class="container">
    <h4 class="mb-3">Today's Minyanim</h4>
    <div class="row g-3 mb-5">
      ${todaysCards.length ? todaysCards.join("") : '<div class="col-xs-12"><p class="text-muted">No minyanim scheduled for today yet.</p></div>'}
    </div>
    <h4 class="mb-3">All Shuls &amp; Minyanim</h4>
    ${allHtml}
  </div>`;
}

async function renderMinyanCard(m, shul) {
  const occDate = Data.getOccurrenceDate(m.resetTime);
  let rsvps = [];
  if (m.showCount || m.showNames) {
    rsvps = await Data.getRSVPsForOccurrence(m.id, occDate);
  }
  const identity = myIdentity(getSavedGuestName());
  const iAmComing = rsvps.some(r => Data.isMyRSVP(r, identity));
  const requireLogin = !shul || shul.requireLogin !== false;

  let rsvpControl;
  if (currentUser) {
    rsvpControl = `
      <button class="btn btn-sm ${iAmComing ? "btn-success" : "btn-outline-primary"} rsvp-btn" data-minyan-id="${m.id}" data-rsvped="${iAmComing}">
        <i class="bi bi-${iAmComing ? "check-circle-fill" : "plus-circle"} me-1"></i>${iAmComing ? "I'm Coming" : "Count Me In"}
      </button>`;
  } else if (requireLogin) {
    rsvpControl = `<a href="#/login" class="btn btn-sm btn-outline-primary">Log in to RSVP</a>`;
  } else if (iAmComing) {
    rsvpControl = `
      <button class="btn btn-sm btn-success guest-rsvp-toggle-btn" data-minyan-id="${m.id}">
        <i class="bi bi-check-circle-fill me-1"></i>I'm Coming
      </button>`;
  } else {
    rsvpControl = `
      <form class="guest-rsvp-form d-flex gap-1" data-minyan-id="${m.id}">
        <input type="text" class="form-control input-sm guest-name-input" placeholder="Your name" value="${escapeHtml(getSavedGuestName())}" required>
        <button type="submit" class="btn btn-sm btn-outline-primary">Count Me In</button>
      </form>`;
  }

  return `
  <div class="col-xs-12 col-md-6 col-lg-4">
    <div class="card h-100 shadow-sm border-0">
      <div class="card-body d-flex flex-column">
        <h5 class="card-title mb-1">${escapeHtml(m.name)}</h5>
        <div class="text-muted small mb-2">${escapeHtml(shul?.name || "")}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
        <div class="mb-2"><i class="bi bi-clock me-1"></i>${Data.formatTime12(m.time)}</div>
        ${m.showCount ? `<div class="mb-2"><span class="badge bg-primary-subtle text-primary">${rsvps.length} coming</span></div>` : ""}
        ${m.showNames ? `<div class="small text-muted mb-3">${rsvps.length ? rsvps.map(r => escapeHtml(r.userName)).join(", ") : "No one yet"}</div>` : ""}
        <div class="mt-auto pt-2">
          ${rsvpControl}
        </div>
      </div>
    </div>
  </div>`;
}

// ---- Public shul page (shareable link, mobile-friendly) ----

async function viewPublicShul(shulId) {
  const shul = await Data.getShul(shulId);
  if (!shul) return `<div class="container"><p class="text-danger">Shul not found.</p></div>`;
  shulCache[shul.id] = shul;

  const minyanim = await Data.getMinyanimForShul(shulId);
  minyanim.forEach(m => { minyanCache[m.id] = m; });

  const todays = minyanim.filter(Data.isMinyanActiveToday);
  const others = minyanim.filter(m => !Data.isMinyanActiveToday(m));
  const todaysCards = await Promise.all(todays.map(m => renderMinyanCard(m, shul)));

  const othersHtml = others.length ? `
    <h5 class="mb-2 mt-4">Full Schedule</h5>
    <div class="list-group mb-4">
      ${others.map(m => `
        <div class="list-group-item">
          <div class="fw-semibold">${escapeHtml(m.name)}</div>
          <div class="small text-muted">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
        </div>
      `).join("")}
    </div>` : "";

  return `
  <div class="container">
    <div class="text-center mb-4">
      <h3 class="mb-1">${escapeHtml(shul.name)}</h3>
      <div class="text-muted">${escapeHtml(shul.address || "")}</div>
    </div>
    <div class="row g-3">
      ${todaysCards.length ? todaysCards.join("") : '<div class="col-xs-12"><p class="text-muted text-center">No minyanim scheduled for today.</p></div>'}
    </div>
    ${othersHtml}
  </div>`;
}

// ---- Dashboard (my shuls) ----

async function viewDashboard() {
  const shuls = await Data.getMyShuls(currentUser.uid);
  return `
  <div class="container">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h4 class="mb-0">My Shuls</h4>
      <button class="btn btn-primary btn-sm" id="newShulBtn"><i class="bi bi-plus-lg me-1"></i>New Shul</button>
    </div>
    <div class="row g-3">
      ${shuls.length ? shuls.map(s => `
        <div class="col-xs-12 col-md-6 col-lg-4">
          <a href="#/shul/${s.id}" class="text-decoration-none">
            <div class="card h-100 shadow-sm border-0">
              <div class="card-body">
                <h5 class="card-title">${escapeHtml(s.name)}${s.ownerId !== currentUser.uid ? ' <span class="badge bg-primary-subtle text-primary">Managed</span>' : ""}</h5>
                <p class="card-text text-muted small mb-0">${escapeHtml(s.address || "")}</p>
              </div>
            </div>
          </a>
        </div>
      `).join("") : `<div class="col-xs-12"><p class="text-muted">You haven't created a shul yet.</p></div>`}
    </div>
    <div id="shulModalContainer"></div>
  </div>`;
}

function shulModal(existing) {
  return `
  <div class="modal fade" id="shulModal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <form id="shulForm">
          <input type="hidden" name="id" value="${existing ? existing.id : ""}">
          <div class="modal-header">
            <button type="button" class="close" data-dismiss="modal">&times;</button>
            <h5 class="modal-title">${existing ? "Edit Shul" : "New Shul"}</h5>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">Shul Name</label>
              <input type="text" class="form-control" name="name" value="${existing ? escapeHtml(existing.name) : ""}" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Address</label>
              <input type="text" class="form-control" name="address" value="${existing ? escapeHtml(existing.address || "") : ""}">
            </div>
            <div class="checkbox mb-1">
              <label><input type="checkbox" name="requireLogin" ${!existing || existing.requireLogin !== false ? "checked" : ""}> Require an account to RSVP</label>
            </div>
            <div class="form-text mb-3">If unchecked, visitors can RSVP with just their name — no sign up needed.</div>
            <div class="checkbox mb-1">
              <label><input type="checkbox" name="unlisted" ${existing && existing.unlisted ? "checked" : ""}> Hide this shul from the site's homepage</label>
            </div>
            <div class="form-text">It'll only be reachable via its public link (Copy Public Link on the shul page) — not listed for everyone browsing the homepage.</div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">${existing ? "Save Changes" : "Create Shul"}</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

// ---- Shul detail ----

async function viewShul(shulId) {
  const shul = await Data.getShul(shulId);
  if (!shul) return `<div class="container"><p class="text-danger">Shul not found.</p></div>`;
  if (!Data.isShulManager(shul, currentUser.uid)) {
    return `<div class="container"><p class="text-danger">You don't have access to manage this shul.</p></div>`;
  }
  const isOwner = shul.ownerId === currentUser.uid;
  shulCache[shul.id] = shul;
  const minyanim = await Data.getMinyanimForShul(shulId);
  minyanim.forEach(m => { minyanCache[m.id] = m; });

  // Owner/managers always see the full RSVP list for today, regardless of
  // what's shown publicly.
  const todaysRsvps = {};
  await Promise.all(minyanim.filter(Data.isMinyanActiveToday).map(async m => {
    const occDate = Data.getOccurrenceDate(m.resetTime);
    todaysRsvps[m.id] = await Data.getRSVPsForOccurrence(m.id, occDate);
  }));

  const publicUrl = `${location.origin}${location.pathname}#/s/${shulId}`;

  return `
  <div class="container">
    <p class="mb-2"><a href="#/dashboard" class="text-decoration-none"><i class="bi bi-arrow-left me-1"></i>My Shuls</a></p>
    <div class="d-flex justify-content-between align-items-start mb-2 flex-wrap gap-2">
      <div>
        <h4 class="mb-0">${escapeHtml(shul.name)}${shul.unlisted ? ' <span class="badge bg-primary-subtle text-primary">Hidden from homepage</span>' : ""}</h4>
        <div class="text-muted small">${escapeHtml(shul.address || "")}</div>
      </div>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-sm btn-outline-secondary" id="copyLinkBtn" data-url="${escapeHtml(publicUrl)}"><i class="bi bi-link-45deg me-1"></i>Copy Public Link</button>
        <button class="btn btn-sm btn-outline-secondary" id="notifyPrefsBtn"><i class="bi bi-bell me-1"></i>Notifications</button>
        ${isOwner ? `
          <button class="btn btn-sm btn-outline-secondary" id="editShulBtn"><i class="bi bi-gear me-1"></i>Edit Shul</button>
          <button class="btn btn-sm btn-outline-secondary" id="manageAccessBtn"><i class="bi bi-people me-1"></i>Manage Access</button>
          <button class="btn btn-sm btn-outline-danger" id="deleteShulBtn"><i class="bi bi-trash me-1"></i>Delete Shul</button>
        ` : ""}
        <button class="btn btn-sm btn-primary" id="newMinyanBtn"><i class="bi bi-plus-lg me-1"></i>New Minyan</button>
      </div>
    </div>
    <div id="copyLinkMsg" class="small text-success mb-3 d-none">Link copied to clipboard!</div>

    <div class="list-group mb-4">
      ${minyanim.length ? minyanim.map(m => {
        const isToday = Data.isMinyanActiveToday(m);
        const rsvps = todaysRsvps[m.id] || [];
        return `
        <div class="list-group-item">
          <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <div>
              <div class="fw-semibold">${escapeHtml(m.name)}${isToday ? ' <span class="badge bg-success-subtle text-success">Today</span>' : ""}</div>
              <div class="small text-muted">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
              <div class="small text-muted">Resets daily at ${Data.formatTime12(m.resetTime || "00:00")} · ${m.showCount ? "Count shown publicly" : "Count hidden publicly"} · ${m.showNames ? "Names shown publicly" : "Names hidden publicly"}</div>
            </div>
            <div class="d-flex gap-2">
              <button class="btn btn-sm btn-outline-secondary edit-minyan-btn" data-id="${m.id}"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger delete-minyan-btn" data-id="${m.id}"><i class="bi bi-trash"></i></button>
            </div>
          </div>
          ${isToday ? `
            <div class="admin-rsvp-panel mt-2">
              <span class="badge bg-primary-subtle text-primary">${rsvps.length} coming today</span>
              <span class="small text-muted"> (visible to you as owner/manager even if hidden publicly)</span>
              <div class="small text-muted mt-1">${rsvps.length ? rsvps.map(r => escapeHtml(r.userName)).join(", ") : "No one yet"}</div>
            </div>
          ` : ""}
        </div>
      `; }).join("") : `<div class="list-group-item text-muted">No minyanim yet. Add one!</div>`}
    </div>

    <div id="minyanModalContainer"></div>
    <div id="notifyPrefsModalContainer"></div>
    ${isOwner ? `<div id="shulEditModalContainer"></div><div id="accessModalContainer"></div>` : ""}
  </div>`;
}

function minyanModal(shul, editing) {
  const isOneTime = !editing || editing.type === "one-time";
  return `
  <div class="modal fade" id="minyanModal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <form id="minyanForm">
          <input type="hidden" name="id" value="${editing ? editing.id : ""}">
          <div class="modal-header">
            <button type="button" class="close" data-dismiss="modal">&times;</button>
            <h5 class="modal-title">${editing ? "Edit Minyan" : "New Minyan"}</h5>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">Minyan Name</label>
              <input type="text" class="form-control" name="name" value="${editing ? escapeHtml(editing.name) : ""}" placeholder="e.g. Shacharis" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Place</label>
              <input type="text" class="form-control" name="place" value="${editing ? escapeHtml(editing.place || "") : ""}" placeholder="${escapeHtml(shul.address || "Main sanctuary")}">
            </div>
            <div class="mb-3">
              <label class="form-label d-block">Schedule Type</label>
              <div class="btn-group" data-toggle="buttons">
                <label class="btn btn-outline-primary btn-sm ${isOneTime ? "active" : ""}">
                  <input type="radio" name="type" value="one-time" ${isOneTime ? "checked" : ""}> One-Time
                </label>
                <label class="btn btn-outline-primary btn-sm ${!isOneTime ? "active" : ""}">
                  <input type="radio" name="type" value="recurring" ${!isOneTime ? "checked" : ""}> Recurring
                </label>
              </div>
            </div>
            <div class="mb-3" id="dateField" style="${isOneTime ? "" : "display:none"}">
              <label class="form-label">Date</label>
              <input type="date" class="form-control" name="date" value="${editing && editing.date ? editing.date : ""}">
            </div>
            <div class="mb-3" id="daysField" style="${isOneTime ? "display:none" : ""}">
              <label class="form-label d-block">Days of Week</label>
              <div class="d-flex flex-wrap gap-2">
                ${Data.DAY_NAMES.map((d, i) => `
                  <label class="checkbox-inline">
                    <input type="checkbox" name="daysOfWeek" value="${i}" ${editing && editing.daysOfWeek && editing.daysOfWeek.includes(i) ? "checked" : ""}> ${d}
                  </label>
                `).join("")}
              </div>
            </div>
            <div class="mb-3">
              <label class="form-label">Time</label>
              <input type="time" class="form-control" name="time" value="${editing ? editing.time || "" : ""}" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Daily Reset Time</label>
              <input type="time" class="form-control" name="resetTime" value="${editing ? editing.resetTime || "00:00" : "00:00"}">
              <div class="form-text">The "coming" count and names list clears and starts fresh at this time each day.</div>
            </div>
            <div class="checkbox mb-2">
              <label><input type="checkbox" name="showCount" ${!editing || editing.showCount ? "checked" : ""}> Show how many are coming on the public page</label>
            </div>
            <div class="checkbox mb-2">
              <label><input type="checkbox" name="showNames" ${editing && editing.showNames ? "checked" : ""}> Show names of who's coming on the public page</label>
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">${editing ? "Save Changes" : "Create Minyan"}</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

// ---- Manage Access (invite/remove managers by email) ----

function managerListHtml(managerUsers) {
  return managerUsers.length ? managerUsers.map(u => `
    <div class="list-group-item d-flex justify-content-between align-items-center">
      <div>
        <div class="fw-semibold">${escapeHtml(u.name || u.email)}</div>
        <div class="small text-muted">${escapeHtml(u.email)}</div>
      </div>
      <button type="button" class="btn btn-sm btn-outline-danger remove-manager-btn" data-uid="${u.uid}"><i class="bi bi-trash"></i></button>
    </div>
  `).join("") : '<div class="list-group-item text-muted">No one else has access yet.</div>';
}

function accessModal() {
  return `
  <div class="modal fade" id="accessModal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <button type="button" class="close" data-dismiss="modal">&times;</button>
          <h5 class="modal-title">Manage Access</h5>
        </div>
        <div class="modal-body">
          <p class="text-muted small">People you add here can create, edit, and delete this shul's minyanim, and can always see the full RSVP list — even when it's hidden from the public.</p>
          <div id="accessError" class="alert alert-danger d-none"></div>
          <form id="addManagerForm" class="d-flex gap-2 mb-3">
            <input type="email" class="form-control" name="email" placeholder="person@example.com" required>
            <button type="submit" class="btn btn-primary">Add</button>
          </form>
          <div class="list-group" id="managerListArea"></div>
        </div>
      </div>
    </div>
  </div>`;
}

// ---- Notification preferences (per admin, per shul) ----

function notifyPrefsModal(shul) {
  const prefs = (shul.notifyPrefs && shul.notifyPrefs[currentUser.uid]) || Data.defaultNotifyPrefs();
  return `
  <div class="modal fade" id="notifyPrefsModal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <form id="notifyPrefsForm">
          <div class="modal-header">
            <button type="button" class="close" data-dismiss="modal">&times;</button>
            <h5 class="modal-title">Email Notifications</h5>
          </div>
          <div class="modal-body">
            <p class="text-muted small">Get an email as soon as someone RSVPs to this shul.</p>
            <div class="checkbox">
              <label>
                <input type="checkbox" name="enabled" ${prefs.enabled ? "checked" : ""}>
                Email me when someone RSVPs
              </label>
            </div>
            <div class="mb-3 mt-3">
              <label class="form-label">Send to this email instead of my account email (optional)</label>
              <input type="email" class="form-control" name="email" value="${escapeHtml(prefs.email || "")}" placeholder="${escapeHtml(currentUser.email || "")}">
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">Save Preferences</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

// ---- Event wiring ----

function wireEvents(route) {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await logOut();
    location.hash = "#/";
  });

  document.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("loginForm").classList.toggle("d-none", btn.dataset.tab !== "login");
      document.getElementById("signupForm").classList.toggle("d-none", btn.dataset.tab !== "signup");
    });
  });

  const loginForm = document.getElementById("loginForm");
  if (loginForm) loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    try {
      await logIn(fd.get("email"), fd.get("password"));
      location.hash = "#/dashboard";
    } catch (err) {
      showAuthError(err);
    }
  });

  const signupForm = document.getElementById("signupForm");
  if (signupForm) signupForm.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(signupForm);
    try {
      await signUp(fd.get("name"), fd.get("email"), fd.get("password"));
      location.hash = "#/dashboard";
    } catch (err) {
      showAuthError(err);
    }
  });

  document.querySelectorAll(".rsvp-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const m = minyanCache[btn.dataset.minyanId];
      if (!m || !currentUser) return;
      const wasAlreadyRsvpd = btn.dataset.rsvped === "true";
      btn.disabled = true;
      try {
        const identity = myIdentity();
        await Data.toggleRSVP(m, identity, wasAlreadyRsvpd);
        if (!wasAlreadyRsvpd) notifyNewRsvp(m, shulCache[m.shulId], identity.userName);
      } catch (err) {
        console.error(err);
        alert("Couldn't update your RSVP. Please try again.");
      } finally {
        render();
      }
    });
  });

  // Only rendered when the guest is already RSVP'd, so this is always a removal.
  document.querySelectorAll(".guest-rsvp-toggle-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const m = minyanCache[btn.dataset.minyanId];
      if (!m) return;
      btn.disabled = true;
      try {
        await Data.toggleRSVP(m, myIdentity(getSavedGuestName()), true);
      } catch (err) {
        console.error(err);
        alert("Couldn't update your RSVP. Please try again.");
      } finally {
        render();
      }
    });
  });

  // Only rendered when the guest isn't RSVP'd yet, so this is always a new RSVP.
  document.querySelectorAll(".guest-rsvp-form").forEach(form => {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const m = minyanCache[form.dataset.minyanId];
      const name = form.querySelector(".guest-name-input").value.trim();
      if (!m || !name) return;
      localStorage.setItem("minyanGuestName", name);
      try {
        await Data.toggleRSVP(m, myIdentity(name), false);
        notifyNewRsvp(m, shulCache[m.shulId], name);
      } catch (err) {
        console.error(err);
        alert("Couldn't update your RSVP. Please try again.");
      } finally {
        render();
      }
    });
  });

  const copyLinkBtn = document.getElementById("copyLinkBtn");
  if (copyLinkBtn) copyLinkBtn.addEventListener("click", async () => {
    const url = copyLinkBtn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API may be unavailable (e.g. non-secure context); ignore
    }
    const msg = document.getElementById("copyLinkMsg");
    if (msg) {
      msg.classList.remove("d-none");
      setTimeout(() => msg.classList.add("d-none"), 2500);
    }
  });

  if (route[0] === "dashboard") wireDashboard();
  if (route[0] === "shul" && route[1]) wireShul(route[1]);
}

function showAuthError(err) {
  const el = document.getElementById("authError");
  if (el) {
    el.textContent = friendlyAuthError(err);
    el.classList.remove("d-none");
  }
}

function wireDashboard() {
  const newShulBtn = document.getElementById("newShulBtn");
  if (newShulBtn) newShulBtn.addEventListener("click", () => {
    document.getElementById("shulModalContainer").innerHTML = shulModal(null);
    wireShulForm();
    $("#shulModal").modal("show");
  });
}

function wireShulForm() {
  const form = document.getElementById("shulForm");
  if (!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const id = fd.get("id");
    const payload = {
      name: fd.get("name"),
      address: fd.get("address"),
      requireLogin: fd.get("requireLogin") === "on",
      unlisted: fd.get("unlisted") === "on"
    };
    if (id) {
      await Data.updateShul(id, payload);
    } else {
      await Data.createShul({
        ...payload,
        ownerId: currentUser.uid,
        ownerName: currentUser.displayName || currentUser.email
      });
    }
    $("#shulModal").modal("hide");
    render();
  });
}

function wireShul(shulId) {
  const deleteShulBtn = document.getElementById("deleteShulBtn");
  if (deleteShulBtn) deleteShulBtn.addEventListener("click", async () => {
    if (!confirm("Delete this shul and all its minyanim? This cannot be undone.")) return;
    const minyanim = await Data.getMinyanimForShul(shulId);
    await Promise.all(minyanim.map(m => Data.deleteMinyan(m.id)));
    await Data.deleteShul(shulId);
    location.hash = "#/dashboard";
  });

  const editShulBtn = document.getElementById("editShulBtn");
  if (editShulBtn) editShulBtn.addEventListener("click", async () => {
    const shul = await Data.getShul(shulId);
    document.getElementById("shulEditModalContainer").innerHTML = shulModal(shul);
    wireShulForm();
    $("#shulModal").modal("show");
  });

  const manageAccessBtn = document.getElementById("manageAccessBtn");
  if (manageAccessBtn) manageAccessBtn.addEventListener("click", () => openAccessModal(shulId));

  const notifyPrefsBtn = document.getElementById("notifyPrefsBtn");
  if (notifyPrefsBtn) notifyPrefsBtn.addEventListener("click", async () => {
    const shul = await Data.getShul(shulId);
    document.getElementById("notifyPrefsModalContainer").innerHTML = notifyPrefsModal(shul);
    const form = document.getElementById("notifyPrefsForm");
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(form);
      await Data.setNotifyPrefs(shulId, currentUser.uid, {
        enabled: fd.get("enabled") === "on",
        email: (fd.get("email") || "").trim()
      });
      $("#notifyPrefsModal").modal("hide");
    });
    $("#notifyPrefsModal").modal("show");
  });

  const newMinyanBtn = document.getElementById("newMinyanBtn");
  if (newMinyanBtn) newMinyanBtn.addEventListener("click", async () => {
    const shul = await Data.getShul(shulId);
    openMinyanModal(shul, null);
  });

  document.querySelectorAll(".edit-minyan-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const shul = await Data.getShul(shulId);
      openMinyanModal(shul, minyanCache[btn.dataset.id]);
    });
  });

  document.querySelectorAll(".delete-minyan-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this minyan?")) return;
      await Data.deleteMinyan(btn.dataset.id);
      render();
    });
  });
}

async function openAccessModal(shulId) {
  document.getElementById("accessModalContainer").innerHTML = accessModal();

  const form = document.getElementById("addManagerForm");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = fd.get("email");
    const errEl = document.getElementById("accessError");
    errEl.classList.add("d-none");
    const user = await Data.findUserByEmail(email);
    if (!user) {
      errEl.textContent = "No account found with that email. Ask them to sign up first, then try again.";
      errEl.classList.remove("d-none");
      return;
    }
    if (user.uid === currentUser.uid) {
      errEl.textContent = "That's you — you already have access.";
      errEl.classList.remove("d-none");
      return;
    }
    await Data.addManager(shulId, user.uid);
    form.reset();
    await refreshManagerList(shulId);
  });

  await refreshManagerList(shulId);
  $("#accessModal").modal("show");
}

async function refreshManagerList(shulId) {
  const shul = await Data.getShul(shulId);
  const managerUsers = (await Promise.all((shul.managers || []).map(uid => Data.getUserById(uid)))).filter(Boolean);
  const area = document.getElementById("managerListArea");
  if (!area) return;
  area.innerHTML = managerListHtml(managerUsers);
  document.querySelectorAll(".remove-manager-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await Data.removeManager(shulId, btn.dataset.uid);
      await refreshManagerList(shulId);
    });
  });
}

function openMinyanModal(shul, editing) {
  const container = document.getElementById("minyanModalContainer");
  container.innerHTML = minyanModal(shul, editing);
  wireMinyanForm(shul.id);
  $("#minyanModal").modal("show");
}

function wireMinyanForm(shulId) {
  const form = document.getElementById("minyanForm");
  if (!form) return;

  const dateField = document.getElementById("dateField");
  const daysField = document.getElementById("daysField");
  function syncFields() {
    const type = form.querySelector('input[name="type"]:checked').value;
    dateField.style.display = type === "one-time" ? "" : "none";
    daysField.style.display = type === "recurring" ? "" : "none";
  }
  // Bootstrap 3's button-group plugin toggles these radios via jQuery's
  // .trigger('change'), which only reaches jQuery-bound handlers — a plain
  // addEventListener('change', ...) here never fires when clicking the
  // One-Time/Recurring buttons, only once the modal is reopened after saving.
  $(form).on("change", 'input[name="type"]', syncFields);
  syncFields();

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = fd.get("type");
    const payload = {
      shulId,
      ownerId: currentUser.uid,
      name: fd.get("name"),
      place: fd.get("place") || "",
      type,
      date: type === "one-time" ? (fd.get("date") || null) : null,
      daysOfWeek: type === "recurring" ? fd.getAll("daysOfWeek").map(Number) : [],
      time: fd.get("time"),
      resetTime: fd.get("resetTime") || "00:00",
      showCount: fd.get("showCount") === "on",
      showNames: fd.get("showNames") === "on"
    };
    const id = fd.get("id");
    if (id) {
      await Data.updateMinyan(id, payload);
    } else {
      await Data.createMinyan(payload);
    }
    $("#minyanModal").modal("hide");
    render();
  });
}
