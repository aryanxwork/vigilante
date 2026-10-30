// utils/feedback.js — reconcile pass: resolve pending feedback rows into real labels,
// AND (shadow mode) feed the honest ones to each user's bandit so it learns.
// The bandit DRIVES NOTHING here — it only learns. The global model still runs everything.
const Feedback = require("../models/Feedback");
const { getAuthClient } = require("./gmail");
const { google } = require("googleapis");
const { buildContext, update } = require("./bandit");
const { loadState, saveState } = require("./banditStore");

const MIN_AGE_HOURS = 24;   // give the user time to act before we judge
const CONTEXT_DIM = 2;      // [bias, global_score] — must match buildContext length

// Only HONEST signals train the bandit. We deliberately EXCLUDE "archived_untouched":
// those are self-confirming (we hid the email, so "no action" doesn't mean unimportant).
// Feeding them would bake the same bias into the bandit that inflated our global AUC.
const GOLD = new Set(["starred", "read", "unarchived", "user_archived", "trashed", "deleted"]);

async function reconcileFeedback(user) {
    const auth = getAuthClient(user);            // synchronous — matches processor.js
    const gmail = google.gmail({ version: "v1", auth });

    const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3600 * 1000);
    const pending = await Feedback.find({
        googleId: user.googleId,
        outcome: "pending",
        scoredAt: { $lte: cutoff },
    }).limit(100);

    if (pending.length === 0) return;

    // Load this user's bandit once; apply all updates in memory; save once at the end.
    const bandit = await loadState(user.googleId, CONTEXT_DIM);
    let banditDirty = false;

    // learn from one resolved row, if its signal is honest and usable
    const learn = (fb, outcome, label) => {
        if (GOLD.has(outcome) && (label === 0 || label === 1) && typeof fb.predictedScore === "number") {
            update(bandit, buildContext(fb.predictedScore), label);
            banditDirty = true;
        }
    };

    for (const fb of pending) {
        let labels;
        try {
            const msg = await gmail.users.messages.get({ userId: "me", id: fb.messageId, format: "minimal" });
            labels = msg.data.labelIds || [];
        } catch (e) {
            if (e.code === 404) {           // message gone entirely → deleted → gold negative
                await resolve(fb, "deleted", 0);
                learn(fb, "deleted", 0);
            }
            continue;
        }

        const s = {
            unread: labels.includes("UNREAD"),
            starred: labels.includes("STARRED"),
            inInbox: labels.includes("INBOX"),
            inTrash: labels.includes("TRASH"),
        };
        const { outcome, label } = classify(fb, s);
        if (outcome) {
            await resolve(fb, outcome, label);
            learn(fb, outcome, label);
        }
    }

    if (banditDirty) {
        await saveState(user.googleId, bandit);
        console.log(`[${user.email}] bandit updated — n=${bandit.n}`);
    }
}

function classify(fb, s) {
    if (fb.action === "archived") {
        if (s.inInbox) return { outcome: "unarchived", label: 1 };          // GOLD: user pulled it back
        if (s.inTrash) return { outcome: "deleted", label: 0 };             // confirmed junk
        return { outcome: "archived_untouched", label: 0 };                 // CONFOUNDED (not fed to bandit)
    }
    if (s.starred) return { outcome: "starred", label: 1 };
    if (!s.unread && s.inInbox) return { outcome: "read", label: 1 };
    if (s.inTrash) return { outcome: "trashed", label: 0 };
    if (!s.inInbox) return { outcome: "user_archived", label: 0 };        // GOLD negative: saw it, dismissed it
    return { outcome: null, label: null };                               // still unread in inbox — ambiguous, skip
}

async function resolve(fb, outcome, label) {
    fb.outcome = outcome;
    fb.label = label;
    fb.resolvedAt = new Date();
    await fb.save();
}

module.exports = { reconcileFeedback };