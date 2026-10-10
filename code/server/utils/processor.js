// utils/processor.js — processes new mail for one user: fetch → score → archive → log → checkpoint
const { google } = require("googleapis");
const User = require("../models/User");
const { getAuthClient, getCurrentHistoryId, fetchNewSince } = require("./gmail");
const { scoreEmails } = require("./scoring");
const Feedback = require("../models/Feedback");

const ARCHIVE_THRESHOLD = 0.2;

// Ensure the "Vigilante/Archived" label exists in THIS account, return its ID.
// (No caching — the label ID differs per account, so we look it up fresh each time.)
async function getArchiveLabelId(gmail) {
    const res = await gmail.users.labels.list({ userId: "me" });
    const existing = (res.data.labels || []).find(
        (l) => l.name === "Vigilante/Archived"
    );
    if (existing) return existing.id;

    // Create it if it doesn't exist in this account
    const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: "Vigilante/Archived",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
        },
    });
    return created.data.id;
}

// Archive an email: remove from INBOX + tag with Vigilante/Archived (reversible)
async function archiveEmail(user, messageId) {
    const auth = getAuthClient(user);
    const gmail = google.gmail({ version: "v1", auth });
    const labelId = await getArchiveLabelId(gmail);
    await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
            removeLabelIds: ["INBOX"],
            addLabelIds: [labelId],
        },
    });
}

// Log the model's decision for one email (upsert — never overwrite the original prediction)
async function logFeedback(user, email, score, action) {
    try {
        await Feedback.updateOne(
            { googleId: user.googleId, messageId: email.id },
            {
                $setOnInsert: {
                    googleId: user.googleId,
                    messageId: email.id,
                    threadId: email.threadId || null,
                    predictedScore: score,
                    action, // "archived" | "kept"
                    features: email.features || null,
                    scoredAt: new Date(),
                },
            },
            { upsert: true }
        );
    } catch (err) {
        // Feedback is best-effort — never let a logging failure break processing
        console.error(`[${user.email}] feedback log failed for ${email.id}:`, err.message);
    }
}

// Process one user's new mail
async function processUser(user) {
    try {
        // --- First run: no checkpoint yet → seed it and stop ---
        if (!user.lastHistoryId) {
            const currentId = await getCurrentHistoryId(user);
            user.lastHistoryId = currentId;
            await user.save();
            console.log(`[${user.email}] seeded checkpoint at ${currentId}`);
            return { seeded: true, processed: 0 };
        }

        // --- Normal run: fetch what's new since the checkpoint ---
        let result;
        try {
            result = await fetchNewSince(user, user.lastHistoryId);
        } catch (err) {
            // Checkpoint too old / expired → re-seed from current and skip this round
            if (err.code === 404 || String(err).includes("historyId")) {
                const currentId = await getCurrentHistoryId(user);
                user.lastHistoryId = currentId;
                await user.save();
                console.log(`[${user.email}] checkpoint expired, re-seeded at ${currentId}`);
                return { reseeded: true, processed: 0 };
            }
            throw err;
        }

        const { emails, latestHistoryId } = result;

        if (emails.length === 0) {
            // Nothing new — just move the checkpoint forward if it advanced
            if (latestHistoryId && latestHistoryId !== user.lastHistoryId) {
                user.lastHistoryId = latestHistoryId;
                await user.save();
            }
            return { processed: 0 };
        }

        // --- Score the new emails ---
        const scored = await scoreEmails(emails);

        // --- Archive the clearly-low ones (reversible) + log every decision ---
        let archivedCount = 0;
        for (const e of scored) {
            if (e.score === null) continue; // scoring failed — don't archive, don't log (no signal to learn from)

            if (e.score < ARCHIVE_THRESHOLD) {
                await archiveEmail(user, e.id);
                archivedCount++;
                await logFeedback(user, e, e.score, "archived");
            } else {
                await logFeedback(user, e, e.score, "kept");
            }
        }

        // --- Move the checkpoint forward ---
        user.lastHistoryId = latestHistoryId;
        await user.save();

        console.log(
            `[${user.email}] processed ${scored.length} new, archived ${archivedCount}`
        );
        return { processed: scored.length, archived: archivedCount };
    } catch (err) {
        console.error(`[${user.email}] processing error:`, err.message);
        return { error: err.message };
    }
}

module.exports = { processUser };