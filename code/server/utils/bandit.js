// utils/bandit.js — per-user LinUCB personalization layer (pure algorithm, no DB).
// Dependency-free: a tiny linear-algebra core so there's nothing extra to install on Lambda.
//
// The idea: each user gets their own small learned state (A, b). Given an email's
// context (currently [bias, global_score]), the bandit estimates how important THIS
// user finds it, and can add an exploration bonus for things it's unsure about.
// It learns online — one update() per resolved feedback row.

// ----------------------------- minimal linear algebra (small dims only) -----------------------------
function identity(d) { const A = []; for (let i = 0; i < d; i++) { A.push(Array(d).fill(0)); A[i][i] = 1; } return A; }
function zeros(d) { return Array(d).fill(0); }
function matVec(A, x) { const d = x.length, y = zeros(d); for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += A[i][j] * x[j]; y[i] = s; } return y; }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Gauss-Jordan inverse — fine for the small context dimensions we use (2–10).
function invert(M) {
    const d = M.length;
    const I = identity(d);
    const A = M.map((row, i) => row.concat(I[i])); // augment [M | I]
    for (let col = 0; col < d; col++) {
        let piv = col;
        for (let r = col + 1; r < d; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        if (Math.abs(A[piv][col]) < 1e-12) throw new Error("singular matrix");
        [A[col], A[piv]] = [A[piv], A[col]];
        const pv = A[col][col];
        for (let j = 0; j < 2 * d; j++) A[col][j] /= pv;
        for (let r = 0; r < d; r++) {
            if (r === col) continue;
            const f = A[r][col];
            if (f === 0) continue;
            for (let j = 0; j < 2 * d; j++) A[r][j] -= f * A[col][j];
        }
    }
    return A.map((row) => row.slice(d));
}

// ----------------------------- context -----------------------------
// Start minimal: [bias, global_score]. The bandit learns, per user, how to map the
// global model's score onto THEIR notion of important (e.g. a personal threshold).
//
// To personalize on more signals later, append them here and bump the dimension when
// you create new states — e.g. buildContext(score, [senderKnown, hasUnsubscribe]).
// Keep values roughly in [0,1] so no single feature dominates.
function buildContext(globalScore, extra = []) {
    return [1, globalScore, ...extra];
}

// ----------------------------- LinUCB per-user state -----------------------------
function newState(d) {
    return { d, A: identity(d), b: zeros(d), n: 0 };
}

// theta = A^{-1} b  — the user's learned weights
function theta(state) {
    return matVec(invert(state.A), state.b);
}

// exploit estimate: this user's personalized importance for the context x
function predict(state, x) {
    return dot(theta(state), x);
}

// UCB score: exploit estimate + exploration bonus (higher when the bandit is unsure).
// alpha controls how much it explores; 0 = pure exploit.
function ucb(state, x, alpha = 0.5) {
    const Ainv = invert(state.A);
    const explore = Math.sqrt(Math.max(0, dot(x, matVec(Ainv, x))));
    return dot(theta(state), x) + alpha * explore;
}

// learn from one observed outcome: reward 1 (user treated it as important) / 0 (not).
// A += x x^T ;  b += reward * x
function update(state, x, reward) {
    const d = state.d;
    for (let i = 0; i < d; i++) {
        for (let j = 0; j < d; j++) state.A[i][j] += x[i] * x[j];
        state.b[i] += reward * x[i];
    }
    state.n += 1;
    return state;
}

module.exports = {
    buildContext, newState, theta, predict, ucb, update,
    _linalg: { identity, zeros, matVec, dot, invert },
};