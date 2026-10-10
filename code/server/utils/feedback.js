const Feedback = require("../models/Feedback");
const { getAuthClient } = require("./gmail");
const { google } = require("googleapis");

const MIN_AGE_HOURS = 24;  // give the user time to actually act

async function reconcileFeedback(user) {
    const auth = await getAuthClient(user);
    const gmail = google.gmail({ version: "v1", auth });

    const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3600 * 1000);
    const pending = await Feedback.find({
        googleId: user.googleId,
        outcome: "pending",
        scoredAt: { $lte: cutoff },
    }).limit(100);

    for (const fb of pending) {
        let labels;
        try {
            const msg = await gmail.users.messages.get({
                userId: "me", id: fb.messageId, format: "minimal", // labelIds only — cheap
            });
            labels = msg.data.labelIds || [];
        } catch (e) {
            if (e.code === 404) await resolve(fb, "deleted", 0); // gone = junk, label 0
            continue;
        }

        const s = {
            unread: labels.includes("UNREAD"),
            starred: labels.includes("STARRED"),
            inInbox: labels.includes("INBOX"),
            inTrash: labels.includes("TRASH"),
        };
        const { outcome, label } = classify(fb, s);
        if (outcome) await resolve(fb, outcome, label);
    }
}

function classify(fb, s) {
    if (fb.action === "archived") {
        if (s.inInbox) return { outcome: "unarchived", label: 1 };          // GOLD: user pulled it back — we were wrong
        if (s.inTrash) return { outcome: "deleted", label: 0 };          // confirmed junk
        return { outcome: "archived_untouched", label: 0 };                 // weak — user never saw it (see caveat)
    }
    // we KEPT it in inbox
    if (s.starred) return { outcome: "starred", label: 1 };   // strong positive
    if (!s.unread && s.inInbox) return { outcome: "read", label: 1 };   // opened
    if (s.inTrash) return { outcome: "trashed", label: 0 };   // we overscored
    if (!s.inInbox) return { outcome: "user_archived", label: 0 };   // GOLD negative: they saw & dismissed
    return { outcome: null, label: null };                                      // still unread in inbox — AMBIGUOUS, skip
}

async function resolve(fb, outcome, label) {
    fb.outcome = outcome;
    fb.label = label;
    fb.resolvedAt = new Date();
    await fb.save();
}

module.exports = { reconcileFeedback };