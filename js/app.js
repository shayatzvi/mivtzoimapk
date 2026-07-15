import { watchAuth, signUp, logIn, logOut } from "./auth.js";
import * as Data from "./data.js";
import { NOTIFY_WEBHOOK_URL } from "./notify-config.js";

const appEl = document.getElementById("app");

let currentUser = null;
let authReady = false;
const minyanCache = {};
const shulCache = {};

// Fire-and-forget POST to the Apps Script Web App (see js/notify-config.js).
// Only called for brand-new RSVPs, never for un-RSVPing or admin edits.
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

function formatDateTime(ts) {
  if (ts && typeof ts.toDate === "function") return ts.toDate().toLocaleString();
  return "—";
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

// ---- Modal controller ----
// USWDS's modal CSS only needs is-hidden/is-visible on the wrapper plus a
// body class for scroll-locking; we drive those ourselves instead of relying
// on the bundled uswds.min.js component JS, since modal content here is
// injected dynamically and we want full control over open/close timing.

function modalShell(id, title, innerHtml, opts = {}) {
  const headingId = `${id}-heading`;
  return `
  <div class="usa-modal-wrapper is-hidden">
    <div class="usa-modal-overlay">
      <div class="usa-modal ${opts.large ? "usa-modal--lg" : ""}" id="${id}" aria-labelledby="${headingId}">
        <div class="usa-modal__content">
          <div class="usa-modal__main">
            <h2 class="usa-modal__heading" id="${headingId}">${title}</h2>
            ${innerHtml}
          </div>
          <button type="button" class="usa-button usa-modal__close" data-close-modal aria-label="Close this window">
            <svg class="usa-icon" aria-hidden="true" focusable="false" role="img" width="24" height="24"><use xlink:href="uswds/img/sprite.svg#close"></use></svg>
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

function openModal(id) {
  const modal = document.getElementById(id);
  const wrapper = modal && modal.closest(".usa-modal-wrapper");
  if (!wrapper) return;
  wrapper.classList.remove("is-hidden");
  wrapper.classList.add("is-visible");
  document.body.classList.add("usa-js-modal--active");
}

function closeAllModals() {
  document.querySelectorAll(".usa-modal-wrapper.is-visible").forEach(w => {
    w.classList.remove("is-visible");
    w.classList.add("is-hidden");
  });
  document.body.classList.remove("usa-js-modal--active");
}

document.addEventListener("click", e => {
  if (e.target.classList.contains("usa-modal-overlay") || e.target.closest("[data-close-modal]")) {
    closeAllModals();
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeAllModals();
});

// ---- Routing ----

function currentRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  return hash.split("/").filter(Boolean);
}

window.addEventListener("hashchange", render);
document.addEventListener("DOMContentLoaded", () => {
  appEl.innerHTML = header() + `<main id="main-content" class="grid-container padding-y-5 text-center text-base"><p>Loading…</p></main>` + footer();
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
    content = `
      <div class="grid-container padding-y-4">
        <div class="usa-alert usa-alert--error" role="alert">
          <div class="usa-alert__body">
            <p class="usa-alert__text">Something went wrong loading this page. Please try again.</p>
          </div>
        </div>
      </div>`;
  }
  appEl.innerHTML = header() + `<main id="main-content">${content}</main>` + footer();
  wireEvents(route);
}

// ---- Header / footer ----

function header() {
  return `
  <header class="site-header bg-white border-bottom-1px border-base-lighter">
    <div class="grid-container display-flex flex-align-center flex-justify padding-y-2 flex-wrap" style="gap:1rem">
      <div class="usa-logo margin-0">
        <em class="usa-logo__text"><a href="#/" title="Home">Minyan Times</a></em>
      </div>
      <nav class="display-flex flex-align-center flex-wrap" style="gap:.75rem" aria-label="Primary">
        <a href="#/" class="usa-button usa-button--outline">Home</a>
        ${currentUser ? `
          <a href="#/dashboard" class="usa-button usa-button--outline">My Shuls</a>
          <span class="site-header-user text-base-dark font-sans-3xs">${escapeHtml(currentUser.displayName || currentUser.email)}</span>
          <button id="logoutBtn" class="usa-button usa-button--outline">Sign Out</button>
        ` : `
          <a href="#/login" class="usa-button">Sign In / Sign Up</a>
        `}
      </nav>
    </div>
  </header>`;
}

function footer() {
  return `
  <footer class="usa-footer usa-footer--slim margin-top-6">
    <div class="grid-container usa-footer__return-to-top">
      <a href="#/">Return to top</a>
    </div>
    <div class="usa-footer__primary-section">
      <div class="grid-container">
        <p class="usa-footer__logo-heading">Minyan Times</p>
        <p class="text-base-dark font-sans-3xs">A community minyan scheduling tool. Not affiliated with any government agency.</p>
      </div>
    </div>
  </footer>`;
}

// ---- Auth view ----

function viewAuth() {
  return `
  <div class="grid-container padding-y-5">
    <div class="grid-row flex-justify-center">
      <div class="tablet:grid-col-8 desktop:grid-col-5">
        <div class="usa-card">
          <div class="usa-card__container">
            <div class="usa-card__body">
              <div class="display-flex margin-bottom-3" style="gap:.5rem" role="tablist">
                <button type="button" class="usa-button auth-tab-btn" data-tab="login" aria-selected="true">Log In</button>
                <button type="button" class="usa-button usa-button--outline auth-tab-btn" data-tab="signup" aria-selected="false">Sign Up</button>
              </div>
              <div id="authError" class="usa-alert usa-alert--error usa-alert--slim display-none margin-bottom-2" role="alert">
                <div class="usa-alert__body"><p class="usa-alert__text" id="authErrorText"></p></div>
              </div>
              <form id="loginForm" class="usa-form maxw-none">
                <div class="usa-form-group">
                  <label class="usa-label" for="loginEmail">Email</label>
                  <input class="usa-input" id="loginEmail" name="email" type="email" required>
                </div>
                <div class="usa-form-group">
                  <label class="usa-label" for="loginPassword">Password</label>
                  <input class="usa-input" id="loginPassword" name="password" type="password" required>
                </div>
                <button class="usa-button width-full" type="submit">Log In</button>
              </form>
              <form id="signupForm" class="usa-form maxw-none display-none">
                <div class="usa-form-group">
                  <label class="usa-label" for="signupName">Full Name</label>
                  <input class="usa-input" id="signupName" name="name" type="text" required>
                </div>
                <div class="usa-form-group">
                  <label class="usa-label" for="signupEmail">Email</label>
                  <input class="usa-input" id="signupEmail" name="email" type="email" required>
                </div>
                <div class="usa-form-group">
                  <label class="usa-label" for="signupPassword">Password</label>
                  <input class="usa-input" id="signupPassword" name="password" type="password" minlength="6" required>
                </div>
                <button class="usa-button width-full" type="submit">Create Account</button>
              </form>
            </div>
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
    <div class="margin-bottom-4">
      <h3 class="font-sans-md margin-bottom-1">${escapeHtml(s.name)}${s.address ? ` <span class="text-base-dark font-sans-3xs">— ${escapeHtml(s.address)}</span>` : ""}</h3>
      <div class="stacked-list">
        ${(byShul[s.id] || []).map(m => `
          <div class="stacked-list-row">
            <div>
              <strong>${escapeHtml(m.name)}</strong>
              <div class="text-base-dark font-sans-3xs">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
            </div>
            ${Data.isMinyanActiveToday(m) ? '<span class="usa-tag bg-success">Today</span>' : ""}
          </div>
        `).join("") || '<p class="text-base-dark">No minyanim yet.</p>'}
      </div>
    </div>
  `).join("") : `<p class="text-base-dark">No shuls yet. <a href="#/login">Sign up</a> to add yours!</p>`;

  return `
  <div class="grid-container padding-y-4">
    <h1 class="font-sans-lg">Today's Minyanim</h1>
    <ul class="usa-card-group margin-bottom-6">
      ${todaysCards.length ? todaysCards.join("") : '<li class="text-base-dark">No minyanim scheduled for today yet.</li>'}
    </ul>
    <h2 class="font-sans-lg">All Shuls &amp; Minyanim</h2>
    ${allHtml}
  </div>`;
}

async function renderMinyanCard(m, shul) {
  const bucket = Data.getRsvpBucketKey(m);
  let rsvps = [];
  if (m.showCount || m.showNames) {
    rsvps = await Data.getRSVPsForOccurrence(m.id, bucket);
  }
  const identity = myIdentity(getSavedGuestName());
  const iAmComing = rsvps.some(r => Data.isMyRSVP(r, identity));
  const requireLogin = !shul || shul.requireLogin !== false;

  let rsvpControl;
  if (currentUser) {
    rsvpControl = `
      <button class="usa-button ${iAmComing ? "rsvp-going" : "usa-button--outline"} rsvp-btn width-full" data-minyan-id="${m.id}" data-rsvped="${iAmComing}">
        ${iAmComing ? "✓ I'm Coming" : "Count Me In"}
      </button>`;
  } else if (requireLogin) {
    rsvpControl = `<a href="#/login" class="usa-button usa-button--outline width-full">Log in to RSVP</a>`;
  } else if (iAmComing) {
    rsvpControl = `
      <button class="usa-button rsvp-going guest-rsvp-toggle-btn width-full" data-minyan-id="${m.id}">
        ✓ I'm Coming
      </button>`;
  } else {
    rsvpControl = `
      <form class="guest-rsvp-form display-flex" style="gap:.5rem" data-minyan-id="${m.id}">
        <input type="text" class="usa-input margin-0 flex-1 guest-name-input" placeholder="Your name" value="${escapeHtml(getSavedGuestName())}" required>
        <button type="submit" class="usa-button">Count Me In</button>
      </form>`;
  }

  return `
  <li class="usa-card tablet:grid-col-6 desktop:grid-col-4">
    <div class="usa-card__container height-full">
      <div class="usa-card__header">
        <h3 class="usa-card__heading">${escapeHtml(m.name)}</h3>
        <div class="text-base-dark font-sans-3xs">${escapeHtml(shul?.name || "")}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
      </div>
      <div class="usa-card__body">
        <p class="margin-y-1">${Data.formatTime12(m.time)}</p>
        ${m.showCount ? `<p class="margin-y-1"><span class="usa-tag bg-primary">${rsvps.length} coming</span></p>` : ""}
        ${m.showNames ? `<p class="margin-y-1 text-base-dark font-sans-3xs">${rsvps.length ? rsvps.map(r => escapeHtml(r.userName)).join(", ") : "No one yet"}</p>` : ""}
      </div>
      <div class="usa-card__footer">
        ${rsvpControl}
      </div>
    </div>
  </li>`;
}

// ---- Public shul page (shareable link, mobile-friendly) ----

async function viewPublicShul(shulId) {
  const shul = await Data.getShul(shulId);
  if (!shul) return `<div class="grid-container padding-y-4"><p class="text-secondary">Shul not found.</p></div>`;
  shulCache[shul.id] = shul;

  const minyanim = await Data.getMinyanimForShul(shulId);
  minyanim.forEach(m => { minyanCache[m.id] = m; });

  const todays = minyanim.filter(Data.isMinyanActiveToday);
  const others = minyanim.filter(m => !Data.isMinyanActiveToday(m));
  const todaysCards = await Promise.all(todays.map(m => renderMinyanCard(m, shul)));

  const othersHtml = others.length ? `
    <h2 class="font-sans-lg margin-top-4">Full Schedule</h2>
    <div class="stacked-list margin-bottom-4">
      ${others.map(m => `
        <div class="stacked-list-row">
          <div>
            <strong>${escapeHtml(m.name)}</strong>
            <div class="text-base-dark font-sans-3xs">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
          </div>
        </div>
      `).join("")}
    </div>` : "";

  return `
  <div class="grid-container padding-y-4">
    <div class="text-center margin-bottom-4">
      <h1 class="font-sans-xl margin-bottom-1">${escapeHtml(shul.name)}</h1>
      <div class="text-base-dark">${escapeHtml(shul.address || "")}</div>
    </div>
    <ul class="usa-card-group">
      ${todaysCards.length ? todaysCards.join("") : '<li class="text-base-dark text-center width-full">No minyanim scheduled for today.</li>'}
    </ul>
    ${othersHtml}
  </div>`;
}

// ---- Dashboard (my shuls) ----

async function viewDashboard() {
  const shuls = await Data.getMyShuls(currentUser.uid);
  return `
  <div class="grid-container padding-y-4">
    <div class="display-flex flex-justify flex-align-center margin-bottom-3 flex-wrap" style="gap:.5rem">
      <h1 class="margin-0 font-sans-lg">My Shuls</h1>
      <button class="usa-button" id="newShulBtn">New Shul</button>
    </div>
    <ul class="usa-card-group">
      ${shuls.length ? shuls.map(s => `
        <li class="usa-card tablet:grid-col-6 desktop:grid-col-4">
          <a href="#/shul/${s.id}" class="usa-card__container height-full text-ink text-no-underline">
            <div class="usa-card__header">
              <h3 class="usa-card__heading">${escapeHtml(s.name)}${s.ownerId !== currentUser.uid ? ' <span class="usa-tag bg-primary">Managed</span>' : ""}</h3>
            </div>
            <div class="usa-card__body">
              <p class="text-base-dark font-sans-3xs">${escapeHtml(s.address || "")}</p>
            </div>
          </a>
        </li>
      `).join("") : `<li class="text-base-dark">You haven't created a shul yet.</li>`}
    </ul>
    <div id="shulModalContainer"></div>
  </div>`;
}

function shulModalBody(existing) {
  return `
  <form id="shulForm" class="usa-form maxw-none">
    <input type="hidden" name="id" value="${existing ? existing.id : ""}">
    <div class="usa-form-group">
      <label class="usa-label" for="shulName">Shul Name</label>
      <input class="usa-input" id="shulName" name="name" type="text" value="${existing ? escapeHtml(existing.name) : ""}" required>
    </div>
    <div class="usa-form-group">
      <label class="usa-label" for="shulAddress">Address</label>
      <input class="usa-input" id="shulAddress" name="address" type="text" value="${existing ? escapeHtml(existing.address || "") : ""}">
    </div>
    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="shulRequireLogin" type="checkbox" name="requireLogin" ${!existing || existing.requireLogin !== false ? "checked" : ""}>
      <label class="usa-checkbox__label" for="shulRequireLogin">Require an account to RSVP</label>
    </div>
    <span class="usa-hint display-block margin-bottom-2">If unchecked, visitors can RSVP with just their name — no sign up needed.</span>
    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="shulUnlisted" type="checkbox" name="unlisted" ${existing && existing.unlisted ? "checked" : ""}>
      <label class="usa-checkbox__label" for="shulUnlisted">Hide this shul from the site's homepage</label>
    </div>
    <span class="usa-hint display-block margin-bottom-2">It'll only be reachable via its public link (Copy Public Link on the shul page) — not listed for everyone browsing the homepage.</span>
    <button type="submit" class="usa-button margin-top-2">${existing ? "Save Changes" : "Create Shul"}</button>
  </form>`;
}

// ---- Shul detail ----

async function viewShul(shulId) {
  const shul = await Data.getShul(shulId);
  if (!shul) return `<div class="grid-container padding-y-4"><p class="text-secondary">Shul not found.</p></div>`;
  if (!Data.isShulManager(shul, currentUser.uid)) {
    return `<div class="grid-container padding-y-4"><p class="text-secondary">You don't have access to manage this shul.</p></div>`;
  }
  const isOwner = shul.ownerId === currentUser.uid;
  shulCache[shul.id] = shul;
  const minyanim = await Data.getMinyanimForShul(shulId);
  minyanim.forEach(m => { minyanCache[m.id] = m; });

  // Owner/managers can always view/add/edit attendees for every minyan — the
  // bucket is well-defined regardless of whether it's happening today (today's
  // date for recurring, the fixed date for one-time, or "all" if reset is off).
  const liveRsvps = {};
  await Promise.all(minyanim.map(async m => {
    liveRsvps[m.id] = await Data.getRSVPsForOccurrence(m.id, Data.getRsvpBucketKey(m));
  }));

  const publicUrl = `${location.origin}${location.pathname}#/s/${shulId}`;

  return `
  <div class="grid-container padding-y-4">
    <p class="margin-bottom-2"><a href="#/dashboard">&larr; My Shuls</a></p>
    <div class="display-flex flex-justify flex-align-start margin-bottom-2 flex-wrap" style="gap:.5rem">
      <div>
        <h1 class="margin-0 font-sans-lg">${escapeHtml(shul.name)}${shul.unlisted ? ' <span class="usa-tag bg-primary">Hidden from homepage</span>' : ""}</h1>
        <div class="text-base-dark">${escapeHtml(shul.address || "")}</div>
      </div>
      <div class="display-flex flex-wrap" style="gap:.5rem">
        <button class="usa-button usa-button--outline" id="copyLinkBtn" data-url="${escapeHtml(publicUrl)}">Copy Public Link</button>
        <button class="usa-button usa-button--outline" id="notifyPrefsBtn">Notifications</button>
        ${isOwner ? `
          <button class="usa-button usa-button--outline" id="editShulBtn">Edit Shul</button>
          <button class="usa-button usa-button--outline" id="manageAccessBtn">Manage Access</button>
          <button class="usa-button usa-button--secondary" id="deleteShulBtn">Delete Shul</button>
        ` : ""}
        <button class="usa-button" id="newMinyanBtn">New Minyan</button>
      </div>
    </div>
    <div id="copyLinkMsg" class="usa-alert usa-alert--success usa-alert--slim display-none margin-bottom-3" role="status">
      <div class="usa-alert__body"><p class="usa-alert__text">Link copied to clipboard!</p></div>
    </div>

    <div class="stacked-list margin-bottom-4">
      ${minyanim.length ? minyanim.map(m => {
        const isToday = Data.isMinyanActiveToday(m);
        const rsvps = liveRsvps[m.id] || [];
        return `
        <div class="stacked-list-row">
          <div>
            <strong>${escapeHtml(m.name)}</strong>${isToday ? ' <span class="usa-tag bg-success">Today</span>' : ""}
            <div class="text-base-dark font-sans-3xs">${Data.scheduleDescription(m)}${m.place ? " · " + escapeHtml(m.place) : ""}</div>
            <div class="text-base-dark font-sans-3xs">
              ${m.resetEnabled === false ? "Doesn't reset (running count)" : "Resets daily at " + Data.formatTime12(m.resetTime || "00:00")}
              · ${m.showCount ? "Count shown publicly" : "Count hidden publicly"} · ${m.showNames ? "Names shown publicly" : "Names hidden publicly"}
            </div>
            <div class="margin-top-1"><span class="usa-tag bg-primary">${rsvps.length} coming</span></div>
          </div>
          <div class="stacked-list-actions">
            <button class="usa-button usa-button--outline view-attendees-btn" data-id="${m.id}">Attendees</button>
            <button class="usa-button usa-button--outline edit-minyan-btn" data-id="${m.id}">Edit</button>
            <button class="usa-button usa-button--secondary delete-minyan-btn" data-id="${m.id}">Delete</button>
          </div>
        </div>
      `; }).join("") : `<p class="text-base-dark">No minyanim yet. Add one!</p>`}
    </div>

    <div id="minyanModalContainer"></div>
    <div id="notifyPrefsModalContainer"></div>
    <div id="attendeesModalContainer"></div>
    ${isOwner ? `<div id="shulEditModalContainer"></div><div id="accessModalContainer"></div>` : ""}
  </div>`;
}

function minyanModalBody(shul, editing) {
  const isOneTime = !editing || editing.type === "one-time";
  const resetOn = !editing || editing.resetEnabled !== false;
  return `
  <form id="minyanForm" class="usa-form maxw-none">
    <input type="hidden" name="id" value="${editing ? editing.id : ""}">
    <div class="usa-form-group">
      <label class="usa-label" for="minyanName">Minyan Name</label>
      <input class="usa-input" id="minyanName" name="name" type="text" value="${editing ? escapeHtml(editing.name) : ""}" placeholder="e.g. Shacharis" required>
    </div>
    <div class="usa-form-group">
      <label class="usa-label" for="minyanPlace">Place</label>
      <input class="usa-input" id="minyanPlace" name="place" type="text" value="${editing ? escapeHtml(editing.place || "") : ""}" placeholder="${escapeHtml(shul.address || "Main sanctuary")}">
    </div>

    <fieldset class="usa-fieldset">
      <legend class="usa-legend">Schedule Type</legend>
      <div class="usa-radio">
        <input class="usa-radio__input" id="typeOneTime" type="radio" name="type" value="one-time" ${isOneTime ? "checked" : ""}>
        <label class="usa-radio__label" for="typeOneTime">One-Time</label>
      </div>
      <div class="usa-radio">
        <input class="usa-radio__input" id="typeRecurring" type="radio" name="type" value="recurring" ${!isOneTime ? "checked" : ""}>
        <label class="usa-radio__label" for="typeRecurring">Recurring</label>
      </div>
    </fieldset>

    <div class="usa-form-group" id="dateField" style="${isOneTime ? "" : "display:none"}">
      <label class="usa-label" for="minyanDate">Date</label>
      <input class="usa-input" id="minyanDate" name="date" type="date" value="${editing && editing.date ? editing.date : ""}">
    </div>
    <fieldset class="usa-fieldset" id="daysField" style="${isOneTime ? "display:none" : ""}">
      <legend class="usa-legend">Days of Week</legend>
      ${Data.DAY_NAMES.map((d, i) => `
        <div class="usa-checkbox">
          <input class="usa-checkbox__input" id="day${i}" type="checkbox" name="daysOfWeek" value="${i}" ${editing && editing.daysOfWeek && editing.daysOfWeek.includes(i) ? "checked" : ""}>
          <label class="usa-checkbox__label" for="day${i}">${d}</label>
        </div>
      `).join("")}
    </fieldset>

    <div class="usa-form-group">
      <label class="usa-label" for="minyanTime">Time</label>
      <input class="usa-input" id="minyanTime" name="time" type="time" value="${editing ? editing.time || "" : ""}" required>
    </div>

    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="resetEnabled" type="checkbox" name="resetEnabled" ${resetOn ? "checked" : ""}>
      <label class="usa-checkbox__label" for="resetEnabled">Reset the "coming" count every day</label>
    </div>
    <span class="usa-hint display-block margin-bottom-2">If unchecked, the count never resets — RSVPs keep accumulating until removed.</span>
    <div class="usa-form-group" id="resetTimeField" style="${resetOn ? "" : "display:none"}">
      <label class="usa-label" for="resetTimeInput">Daily Reset Time</label>
      <input class="usa-input" id="resetTimeInput" name="resetTime" type="time" value="${editing ? editing.resetTime || "00:00" : "00:00"}">
      <span class="usa-hint">The "coming" count and names list clears and starts fresh at this time each day.</span>
    </div>

    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="showCount" type="checkbox" name="showCount" ${!editing || editing.showCount ? "checked" : ""}>
      <label class="usa-checkbox__label" for="showCount">Show how many are coming on the public page</label>
    </div>
    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="showNames" type="checkbox" name="showNames" ${editing && editing.showNames ? "checked" : ""}>
      <label class="usa-checkbox__label" for="showNames">Show names of who's coming on the public page</label>
    </div>

    <button type="submit" class="usa-button margin-top-2">${editing ? "Save Changes" : "Create Minyan"}</button>
  </form>`;
}

// ---- Manage Access (invite/remove managers by email) ----

function managerListHtml(managerUsers) {
  return managerUsers.length ? `
    <div class="stacked-list">
      ${managerUsers.map(u => `
        <div class="stacked-list-row">
          <div>
            <strong>${escapeHtml(u.name || u.email)}</strong>
            <div class="text-base-dark font-sans-3xs">${escapeHtml(u.email)}</div>
          </div>
          <button type="button" class="usa-button usa-button--secondary remove-manager-btn" data-uid="${u.uid}">Remove</button>
        </div>
      `).join("")}
    </div>` : '<p class="text-base-dark">No one else has access yet.</p>';
}

function accessModalBody() {
  return `
  <p class="text-base-dark">People you add here can create, edit, and delete this shul's minyanim, and can always see the full RSVP list — even when it's hidden from the public.</p>
  <div id="accessError" class="usa-alert usa-alert--error usa-alert--slim display-none margin-bottom-2" role="alert">
    <div class="usa-alert__body"><p class="usa-alert__text" id="accessErrorText"></p></div>
  </div>
  <form id="addManagerForm" class="usa-form maxw-none display-flex flex-align-end margin-bottom-3" style="gap:.5rem">
    <div class="usa-form-group margin-0 flex-1">
      <label class="usa-label" for="addManagerEmail">Add by email</label>
      <input class="usa-input" id="addManagerEmail" name="email" type="email" placeholder="person@example.com" required>
    </div>
    <button type="submit" class="usa-button">Add</button>
  </form>
  <div id="managerListArea"></div>`;
}

// ---- Notification preferences (per admin, per shul) ----

function notifyPrefsModalBody(shul) {
  const prefs = (shul.notifyPrefs && shul.notifyPrefs[currentUser.uid]) || Data.defaultNotifyPrefs();
  return `
  <form id="notifyPrefsForm" class="usa-form maxw-none">
    <p class="text-base-dark">Get an email as soon as someone RSVPs to this shul.</p>
    <div class="usa-checkbox">
      <input class="usa-checkbox__input" id="notifyEnabled" type="checkbox" name="enabled" ${prefs.enabled ? "checked" : ""}>
      <label class="usa-checkbox__label" for="notifyEnabled">Email me when someone RSVPs</label>
    </div>
    <div class="usa-form-group margin-top-2">
      <label class="usa-label" for="notifyEmail">Send to this email instead of my account email (optional)</label>
      <input class="usa-input" id="notifyEmail" name="email" type="email" value="${escapeHtml(prefs.email || "")}" placeholder="${escapeHtml(currentUser.email || "")}">
    </div>
    <button type="submit" class="usa-button margin-top-2">Save Preferences</button>
  </form>`;
}

// ---- Attendees (view / add / edit / remove, in a table) ----

function attendeesModalBody() {
  return `
  <p class="text-base-dark">Attendees for the current occurrence. Adding someone here records them the same as if they RSVP'd themselves.</p>
  <form id="addAttendeeForm" class="usa-form maxw-none display-flex flex-align-end margin-bottom-3" style="gap:.5rem">
    <div class="usa-form-group margin-0 flex-1">
      <label class="usa-label" for="newAttendeeName">Add attendee</label>
      <input class="usa-input" id="newAttendeeName" name="name" type="text" placeholder="Full name" required>
    </div>
    <button type="submit" class="usa-button">Add</button>
  </form>
  <div class="stacked-list" id="attendeeTableBody"></div>`;
}

function attendeeRowHtml(r) {
  const source = r.uid ? "Account" : (r.addedByAdmin ? "Added by admin" : "Guest");
  return `
  <div class="stacked-list-row" data-rsvp-id="${r.id}">
    <div>
      <span class="attendee-name-display">${escapeHtml(r.userName)}</span>
      <input class="usa-input attendee-name-input display-none margin-0" type="text" value="${escapeHtml(r.userName)}">
      <div class="text-base-dark font-sans-3xs">${source} · ${formatDateTime(r.createdAt)}</div>
    </div>
    <div class="stacked-list-actions">
      <button type="button" class="usa-button usa-button--unstyled edit-attendee-btn">Edit</button>
      <button type="button" class="usa-button usa-button--unstyled save-attendee-btn display-none">Save</button>
      <button type="button" class="usa-button usa-button--unstyled text-secondary remove-attendee-btn">Remove</button>
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

  document.querySelectorAll(".auth-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab-btn").forEach(b => {
        b.classList.toggle("usa-button--outline", b !== btn);
        b.setAttribute("aria-selected", String(b === btn));
      });
      document.getElementById("loginForm").classList.toggle("display-none", btn.dataset.tab !== "login");
      document.getElementById("signupForm").classList.toggle("display-none", btn.dataset.tab !== "signup");
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
      msg.classList.remove("display-none");
      setTimeout(() => msg.classList.add("display-none"), 2500);
    }
  });

  if (route[0] === "dashboard") wireDashboard();
  if (route[0] === "shul" && route[1]) wireShul(route[1]);
}

function showAuthError(err) {
  const wrap = document.getElementById("authError");
  const text = document.getElementById("authErrorText");
  if (wrap && text) {
    text.textContent = friendlyAuthError(err);
    wrap.classList.remove("display-none");
  }
}

function wireDashboard() {
  const newShulBtn = document.getElementById("newShulBtn");
  if (newShulBtn) newShulBtn.addEventListener("click", () => {
    document.getElementById("shulModalContainer").innerHTML = modalShell("shulModal", "New Shul", shulModalBody(null));
    wireShulForm();
    openModal("shulModal");
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
    closeAllModals();
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
    document.getElementById("shulEditModalContainer").innerHTML = modalShell("shulModal", "Edit Shul", shulModalBody(shul));
    wireShulForm();
    openModal("shulModal");
  });

  const manageAccessBtn = document.getElementById("manageAccessBtn");
  if (manageAccessBtn) manageAccessBtn.addEventListener("click", () => openAccessModal(shulId));

  const notifyPrefsBtn = document.getElementById("notifyPrefsBtn");
  if (notifyPrefsBtn) notifyPrefsBtn.addEventListener("click", async () => {
    const shul = await Data.getShul(shulId);
    document.getElementById("notifyPrefsModalContainer").innerHTML = modalShell("notifyPrefsModal", "Email Notifications", notifyPrefsModalBody(shul));
    const form = document.getElementById("notifyPrefsForm");
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(form);
      await Data.setNotifyPrefs(shulId, currentUser.uid, {
        enabled: fd.get("enabled") === "on",
        email: (fd.get("email") || "").trim()
      });
      closeAllModals();
    });
    openModal("notifyPrefsModal");
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

  document.querySelectorAll(".view-attendees-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const m = minyanCache[btn.dataset.id];
      if (m) openAttendeesModal(m);
    });
  });
}

async function openAccessModal(shulId) {
  document.getElementById("accessModalContainer").innerHTML = modalShell("accessModal", "Manage Access", accessModalBody());

  const form = document.getElementById("addManagerForm");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = fd.get("email");
    const errWrap = document.getElementById("accessError");
    const errText = document.getElementById("accessErrorText");
    errWrap.classList.add("display-none");
    const user = await Data.findUserByEmail(email);
    if (!user) {
      errText.textContent = "No account found with that email. Ask them to sign up first, then try again.";
      errWrap.classList.remove("display-none");
      return;
    }
    if (user.uid === currentUser.uid) {
      errText.textContent = "That's you — you already have access.";
      errWrap.classList.remove("display-none");
      return;
    }
    await Data.addManager(shulId, user.uid);
    form.reset();
    await refreshManagerList(shulId);
  });

  await refreshManagerList(shulId);
  openModal("accessModal");
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
  container.innerHTML = modalShell("minyanModal", editing ? "Edit Minyan" : "New Minyan", minyanModalBody(shul, editing));
  wireMinyanForm(shul.id);
  openModal("minyanModal");
}

function wireMinyanForm(shulId) {
  const form = document.getElementById("minyanForm");
  if (!form) return;

  const dateField = document.getElementById("dateField");
  const daysField = document.getElementById("daysField");
  function syncTypeFields() {
    const type = form.querySelector('input[name="type"]:checked').value;
    dateField.style.display = type === "one-time" ? "" : "none";
    daysField.style.display = type === "recurring" ? "" : "none";
  }
  form.querySelectorAll('input[name="type"]').forEach(r => r.addEventListener("change", syncTypeFields));
  syncTypeFields();

  const resetEnabledInput = document.getElementById("resetEnabled");
  const resetTimeField = document.getElementById("resetTimeField");
  resetEnabledInput.addEventListener("change", () => {
    resetTimeField.style.display = resetEnabledInput.checked ? "" : "none";
  });

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
      resetEnabled: fd.get("resetEnabled") === "on",
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
    closeAllModals();
    render();
  });
}

async function openAttendeesModal(minyan) {
  document.getElementById("attendeesModalContainer").innerHTML = modalShell(
    "attendeesModal", `Attendees — ${escapeHtml(minyan.name)}`, attendeesModalBody(), { large: true }
  );

  const form = document.getElementById("addAttendeeForm");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = (fd.get("name") || "").trim();
    if (!name) return;
    await Data.addAttendee(minyan, name);
    form.reset();
    await refreshAttendeesTable(minyan);
  });

  await refreshAttendeesTable(minyan);
  openModal("attendeesModal");
}

async function refreshAttendeesTable(minyan) {
  const bucket = Data.getRsvpBucketKey(minyan);
  const rsvps = await Data.getRSVPsForOccurrence(minyan.id, bucket);
  const body = document.getElementById("attendeeTableBody");
  if (!body) return;
  body.innerHTML = rsvps.length
    ? rsvps.map(attendeeRowHtml).join("")
    : `<p class="text-base-dark">No one yet.</p>`;

  body.querySelectorAll("[data-rsvp-id]").forEach(row => {
    const rsvpId = row.dataset.rsvpId;
    const nameDisplay = row.querySelector(".attendee-name-display");
    const nameInput = row.querySelector(".attendee-name-input");
    const editBtn = row.querySelector(".edit-attendee-btn");
    const saveBtn = row.querySelector(".save-attendee-btn");
    const removeBtn = row.querySelector(".remove-attendee-btn");

    editBtn.addEventListener("click", () => {
      nameDisplay.classList.add("display-none");
      nameInput.classList.remove("display-none");
      editBtn.classList.add("display-none");
      saveBtn.classList.remove("display-none");
      nameInput.focus();
    });

    saveBtn.addEventListener("click", async () => {
      const newName = nameInput.value.trim();
      if (!newName) return;
      saveBtn.disabled = true;
      try {
        await Data.renameAttendee(rsvpId, newName);
        await refreshAttendeesTable(minyan);
      } catch (err) {
        console.error(err);
        alert("Couldn't save that name. Please try again.");
        saveBtn.disabled = false;
      }
    });

    removeBtn.addEventListener("click", async () => {
      if (!confirm("Remove this attendee?")) return;
      try {
        await Data.removeAttendee(rsvpId);
        await refreshAttendeesTable(minyan);
      } catch (err) {
        console.error(err);
        alert("Couldn't remove that attendee. Please try again.");
      }
    });
  });
}
