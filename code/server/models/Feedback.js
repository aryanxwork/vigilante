const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
    {
        googleId: { type: String, required: true, index: true },
        messageId: { type: String, required: true },
        threadId: { type: String },
        predictedScore: { type: Number, required: true },
        action: { type: String, required: true },   // "archived" | "kept"
        explored: { type: Boolean, default: false },   // <-- NEW: true if kept for exploration
        features: { type: Object },
        label: { type: Number, default: null },
        outcome: { type: String, default: "pending" },
        scoredAt: { type: Date, default: Date.now },
        resolvedAt: { type: Date },
    },
    { timestamps: true }
);

feedbackSchema.index({ googleId: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model("Feedback", feedbackSchema);