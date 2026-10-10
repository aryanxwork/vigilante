const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
    {
        googleId: { type: String, required: true, index: true },
        messageId: { type: String, required: true },
        threadId: { type: String },
        predictedScore: { type: Number, required: true },   // 0..1 from the model at decision time
        action: { type: String, required: true },   // what WE did: "archived" | "kept"
        features: { type: Object },                    // feature vector snapshot — the bandit's context
        label: { type: Number, default: null },     // resolved truth: 1 important, 0 not, null unknown
        outcome: { type: String, default: "pending" },// human-readable: "unarchived","read","user_archived"...
        scoredAt: { type: Date, default: Date.now },
        resolvedAt: { type: Date },
    },
    { timestamps: true }
);

feedbackSchema.index({ googleId: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model("Feedback", feedbackSchema);