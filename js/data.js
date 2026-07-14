import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
  setDoc, query, where, or, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { db } from "./firebase-init.js";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n) { return String(n).padStart(2, "0"); }

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The "occurrence date" is the calendar bucket that RSVPs are stored under.
// It only rolls over to the next day once resetTime has passed, so a late
// evening minyan's count doesn't vanish at midnight before the shul wants it to.
export function getOccurrenceDate(resetTime, now = new Date()) {
  const [h, m] = (resetTime || "00:00").split(":").map(Number);
  const cutover = new Date(now);
  cutover.setHours(h, m, 0, 0);
  const base = new Date(now);
  if (now < cutover) base.setDate(base.getDate() - 1);
  return toDateStr(base);
}

export function isMinyanActiveToday(minyan) {
  const occDate = getOccurrenceDate(minyan.resetTime);
  const dow = new Date(occDate + "T12:00:00").getDay();
  if (minyan.type === "one-time") return minyan.date === occDate;
  return (minyan.daysOfWeek || []).includes(dow);
}

export function formatTime12(hhmm) {
  if (!hhmm) return "";
  let [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(m)} ${ampm}`;
}

export function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export function scheduleDescription(minyan) {
  if (minyan.type === "one-time") {
    return `One-time · ${minyan.date ? formatDateLong(minyan.date) : "No date set"} · ${formatTime12(minyan.time)}`;
  }
  const days = (minyan.daysOfWeek || []).slice().sort().map(d => DAY_NAMES[d]).join(", ");
  return `Recurring · ${days || "No days set"} · ${formatTime12(minyan.time)}`;
}

// ---- Shuls ----

export async function createShul({ name, address, ownerId, ownerName, requireLogin = true, unlisted = false }) {
  const ref = await addDoc(collection(db, "shuls"), {
    name, address: address || "", ownerId, ownerName, requireLogin, unlisted, managers: [], createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function updateShul(shulId, data) {
  await updateDoc(doc(db, "shuls", shulId), data);
}

export async function deleteShul(shulId) {
  await deleteDoc(doc(db, "shuls", shulId));
}

export async function getShul(shulId) {
  const snap = await getDoc(doc(db, "shuls", shulId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Shuls this user owns, plus shuls they were added to as a manager.
export async function getMyShuls(uid) {
  const q = query(
    collection(db, "shuls"),
    or(where("ownerId", "==", uid), where("managers", "array-contains", uid))
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getAllShuls() {
  const snap = await getDocs(collection(db, "shuls"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// A manager is a co-owner: someone the shul owner invited by email who can
// then create/edit/delete that shul's minyanim and see full RSVP details.
export function isShulManager(shul, uid) {
  if (!shul || !uid) return false;
  return shul.ownerId === uid || (shul.managers || []).includes(uid);
}

export async function getUserById(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
}

export async function findUserByEmail(email) {
  const q = query(collection(db, "users"), where("email", "==", email.trim().toLowerCase()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { uid: d.id, ...d.data() };
}

export async function addManager(shulId, uid) {
  await updateDoc(doc(db, "shuls", shulId), { managers: arrayUnion(uid) });
}

export async function removeManager(shulId, uid) {
  await updateDoc(doc(db, "shuls", shulId), { managers: arrayRemove(uid) });
}

// ---- Notification preferences (per shul, per owner/manager) ----
// Stored as shuls/{id}.notifyPrefs.{uid} so each admin controls their own
// row without needing full shul-edit rights. When enabled, the site posts a
// small payload to NOTIFY_WEBHOOK_URL (see js/notify-config.js) every time
// someone RSVPs, and an Apps Script Web App emails this admin. `email` is an
// optional override; blank means "use my account email".
export function defaultNotifyPrefs() {
  return { enabled: false, email: "" };
}

export async function setNotifyPrefs(shulId, uid, prefs) {
  await updateDoc(doc(db, "shuls", shulId), { [`notifyPrefs.${uid}`]: prefs });
}

// Resolves the list of admin email addresses to notify for a shul, for
// whichever admins have notifications turned on.
export async function getNotifyEmailsForShul(shul) {
  const prefs = (shul && shul.notifyPrefs) || {};
  const emails = await Promise.all(Object.keys(prefs).map(async uid => {
    const p = prefs[uid];
    if (!p || !p.enabled) return null;
    if (p.email) return p.email;
    const user = await getUserById(uid);
    return user ? user.email : null;
  }));
  return emails.filter(Boolean);
}

// ---- Minyanim ----

export async function createMinyan(data) {
  const ref = await addDoc(collection(db, "minyanim"), { ...data, createdAt: serverTimestamp() });
  return ref.id;
}

export async function updateMinyan(id, data) {
  await updateDoc(doc(db, "minyanim", id), data);
}

export async function deleteMinyan(id) {
  await deleteDoc(doc(db, "minyanim", id));
}

export async function getMinyanimForShul(shulId) {
  const q = query(collection(db, "minyanim"), where("shulId", "==", shulId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getAllMinyanim() {
  const snap = await getDocs(collection(db, "minyanim"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---- RSVPs ----
// Doc id is deterministic (minyanId_occurrenceDate_identityKey) so a person has
// at most one RSVP per occurrence, and toggling is just a set/delete on a known
// id. identityKey is either a Firebase uid (logged-in) or a guest id persisted
// in the browser's localStorage (when a shul allows RSVPing without an account).

function identityKey(identity) {
  return identity.uid || `guest_${identity.guestId}`;
}

export function isMyRSVP(rsvp, identity) {
  if (identity.uid) return rsvp.uid === identity.uid;
  return rsvp.guestId === identity.guestId;
}

export async function getRSVPsForOccurrence(minyanId, occurrenceDate) {
  const q = query(
    collection(db, "rsvps"),
    where("minyanId", "==", minyanId),
    where("occurrenceDate", "==", occurrenceDate)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

// alreadyRsvpd is passed in by the caller (it already knows, from the RSVP
// list it just fetched to render the card) rather than re-checked here with
// a getDoc: a getDoc on a not-yet-existing rsvp doc makes `resource` null in
// the security rules, and our privacy-aware read rule can't safely dereference
// that, so an existence-check read would be denied on every first-time RSVP.
export async function toggleRSVP(minyan, identity, alreadyRsvpd) {
  const occDate = getOccurrenceDate(minyan.resetTime);
  const id = `${minyan.id}_${occDate}_${identityKey(identity)}`;
  const ref = doc(db, "rsvps", id);
  if (alreadyRsvpd) {
    await deleteDoc(ref);
    return false;
  }
  await setDoc(ref, {
    minyanId: minyan.id,
    shulId: minyan.shulId,
    uid: identity.uid || null,
    guestId: identity.uid ? null : identity.guestId,
    userName: identity.userName,
    occurrenceDate: occDate,
    createdAt: serverTimestamp()
  });
  return true;
}
