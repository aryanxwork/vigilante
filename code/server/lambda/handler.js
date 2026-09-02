// lambda/handler.js — serverless entry point for the background classifier
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { processUser } = require("../utils/processor");

// Reuse the DB connection across warm invocations (serverless best practice)
let conn = null;
async function connectDB() {
    if (conn && mongoose.connection.readyState === 1) {
        return conn; // already connected (warm start) — reuse
    }
    conn = await mongoose.connect(process.env.MONGODB_URI);
    return conn;
}

// The handler — this is what the cloud scheduler triggers
exports.handler = async (event) => {
    try {
        await connectDB();

        const users = await User.find({ connected: true });
        console.log(`[lambda] cycle start — ${users.length} connected user(s)`);

        const results = [];
        for (const user of users) {
            const r = await processUser(user);
            results.push({ email: user.email, ...r });
        }

        console.log("[lambda] cycle complete", JSON.stringify(results));

        return {
            statusCode: 200,
            body: JSON.stringify({ processed: results.length, results }),
        };
    } catch (err) {
        console.error("[lambda] cycle error:", err.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message }),
        };
    }
    // Note: we do NOT disconnect mongoose — keeping it open lets warm
    // invocations reuse the connection, which is the serverless pattern.
};