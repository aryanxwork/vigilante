// utils/processor.js — processes new mail for one user: fetch → score → archive → checkpoint
const { google } = require("googleapis");
const User = require("../models/User");
const { getAuthClient, getCurrentHistoryId, fetchNewSince } = require("./gmail");
const { scoreEmails } = require("./scoring");

const ARCHIVE_THRESHOLD = 0.2;


// Ensure the "Vigilante/Archived" label exists, return its ID (cached per process)
let cachedLabelId = null;
async function getArchiveLabelId(gmail) {
    if (cachedLabelId) return cachedLabelId;

    const res = await gmail.users.labels.list({ userId: "me" });
    const existing = (res.data.labels || []).find(
        (l) => l.name === "Vigilante/Archived"
    );
    if (existing) {
        cachedLabelId = existing.id;
        return cachedLabelId;
    }

    // Create it if it doesn't exist
    const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: "Vigilante/Archived",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
        },
    });
    cachedLabelId = created.data.id;
    return cachedLabelId;
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

        // --- Archive the clearly-low ones (reversible) ---
        let archivedCount = 0;
        for (const e of scored) {
            if (e.score !== null && e.score < ARCHIVE_THRESHOLD) {
                await archiveEmail(user, e.id);
                archivedCount++;
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