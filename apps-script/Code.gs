/**
 * Minyan Times — RSVP email notifications (simple test version)
 * ----------------------------------------------------------------
 * Paste this whole file into a Google Apps Script project (script.google.com),
 * deploy it as a Web App, and paste the resulting URL into
 * js/notify-config.js in the site's codebase. That's the whole setup —
 * no service account, no API keys, no scheduled triggers.
 *
 * The site POSTs a small JSON payload here every time someone RSVPs, and
 * this script just emails whichever admin addresses were included.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var subject = "New RSVP for " + data.minyanName + " — " + data.shulName;
    var body =
      data.userName + " said they're coming to " + data.minyanName +
      " at " + data.shulName + (data.place ? " (" + data.place + ")" : "") + ".";

    (data.adminEmails || []).forEach(function (email) {
      if (email) MailApp.sendEmail(email, subject, body);
    });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Optional: open the deployed Web App URL in a browser to sanity-check it's live.
function doGet() {
  return ContentService.createTextOutput("Minyan Times notify endpoint is running.");
}
