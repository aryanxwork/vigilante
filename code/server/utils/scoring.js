// utils/scoring.js — sends emails to the Python scoring service
const axios = require("axios");

const SCORING_URL = process.env.SCORING_SERVICE_URL || "http://localhost:8000";

// Score a batch of emails. Returns the same emails with a `score` and `decision` added.
async function scoreEmails(emails) {
    // Shape each email the way the scoring service expects
    const payload = emails.map((e) => ({
        sender: e.sender,
        subject: e.subject,
        snippet: e.snippet,
        gmail_labels: e.gmail_labels,
        account: "personal",
    }));

    try {
        const res = await axios.post(`${SCORING_URL}/score-batch`, payload, {
            timeout: 15000,
        });

        const results = res.data.results; // array of { score, decision }

        // Attach each score back to its email (same order as sent)
        return emails.map((e, i) => ({
            ...e,
            score: results[i].score,
            decision: results[i].decision,
        }));
    } catch (err) {
        console.error("Scoring service error:", err.message);
        // If scoring fails, return emails unscored rather than crashing
        return emails.map((e) => ({ ...e, score: null, decision: "unknown" }));
    }
}

module.exports = { scoreEmails };