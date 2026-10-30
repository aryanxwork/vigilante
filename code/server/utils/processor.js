// utils/processor.js — fetch → score → (archive | explore | keep) → log → checkpoint
const { google } = require("googleapis");
const User = require("../models/User");
const { getAuthClient, getCurrentHistoryId, fetchNewSince } = require("./gmail");
const { scoreEmails } = require("./scoring");
const Feedback = require("../models/Feedback");

// Tunable via Lambda env vars; defaults are safe.
const ARCHIVE_THRESHOLD = parseFloat(process.env.ARCHIVE_THRESHOLD || "0.2");
const EXPLORE_MIN = parseFloat(process.env.EXPLORE_MIN || "0.1");  // band floor
const EXPLORE_RATE = parseFloat(process.env.EXPLORE_RATE || "0.3"); // % of band kept visible

// Ensure the "Vigilante/Archived" label exists in THIS account, return its ID.
async function getArchiveLabelId(gmail) {
    const res = await gmail.users.labels.list({ userId: "me" });
    const existing = (res.data.labels || []).find((l) => l.name === "Vigilante/Archived");
    if (existing) return existing.id;
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
        requestBody: { removeLabelIds: ["INBOX"], addLabelIds: [labelId] },
    });
}

// Log the model's decision for one email (upsert — never overwrite the original prediction)
async function logFeedback(user, email, score, action, explored) {
    try {
        await Feedback.updateOne(
            { googleId: user.googleId, messageId: email.id },
            {
                $setOnInsert: {
                    googleId: user.googleId,
                    messageId: email.id,
                    threadId: email.threadId || null,
                    predictedScore: score,
                    action,                 // "archived" | "kept"
                    explored: !!explored,   // true only when kept for exploration
                    features: email.features || null,
                    scoredAt: new Date(),
                },
            },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[${user.email}] feedback log failed for ${email.id}:`, err.message);
    }
}

async function processUser(user) {
    try {
        // --- First run: seed checkpoint and stop ---
        if (!user.lastHistoryId) {
            const currentId = await getCurrentHistoryId(user);
            user.lastHistoryId = currentId;
            await user.save();
            console.log(`[${user.email}] seeded checkpoint at ${currentId}`);
            return { seeded: true, processed: 0 };
        }

        // --- Fetch what's new since the checkpoint ---
        let result;
        try {
            result = await fetchNewSince(user, user.lastHistoryId);
        } catch (err) {
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
            if (latestHistoryId && latestHistoryId !== user.lastHistoryId) {
                user.lastHistoryId = latestHistoryId;
                await user.save();
            }
            return { processed: 0 };
        }

        // --- Score ---
        const scored = await scoreEmails(emails);

        // --- Decide per email: keep | explore (keep visible) | archive --- + log every decision
        let archivedCount = 0;
        let exploredCount = 0;

        for (const e of scored) {
            if (e.score === null) continue; // scoring failed — no decision, no log

            // 1) Clearly important → keep in inbox
            if (e.score >= ARCHIVE_THRESHOLD) {
                await logFeedback(user, e, e.score, "kept", false);
                continue;
            }

            // 2) Below threshold but in the borderline band → sometimes EXPLORE (keep visible)
            const inExploreBand = e.score >= EXPLORE_MIN && e.score < ARCHIVE_THRESHOLD;
            if (inExploreBand && Math.random() < EXPLORE_RATE) {
                await logFeedback(user, e, e.score, "kept", true); // kept, flagged explored
                exploredCount++;
                continue;
            }

            // 3) Everything else below threshold → archive
            await archiveEmail(user, e.id);
            archivedCount++;
            await logFeedback(user, e, e.score, "archived", false);
        }

        // --- Advance checkpoint ---
        user.lastHistoryId = latestHistoryId;
        await user.save();

        console.log(
            `[${user.email}] processed ${scored.length} new, archived ${archivedCount}, explored ${exploredCount}`
        );
        return { processed: scored.length, archived: archivedCount, explored: exploredCount };
    } catch (err) {
        console.error(`[${user.email}] processing error:`, err.message);
        return { error: err.message };
    }
}

module.exports = { processUser };