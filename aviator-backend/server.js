const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// --- SERVER & SOCKET INITIALIZATION ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// --- ENVIRONMENT CONFIGURATION ---
const JWT_SECRET = process.env.JWT_SECRET || "pilot_hamoody_secret_key_2026";
const MONGODB_URI = process.env.MONGODB_URI;

// PAYHERO API CONFIGURATION
let rawApiKey = (process.env.PAYHERO_API_KEY || "").replace(/['"]/g, "").trim();
// Automatically remove "Basic " if present to avoid duplicated headers
if (rawApiKey.toLowerCase().startsWith("basic ")) {
    rawApiKey = rawApiKey.slice(6).trim();
}
const PAYHERO_API_KEY = rawApiKey;
const PAYHERO_CHANNEL_ID = (process.env.PAYHERO_CHANNEL_ID || "").replace(/['"]/g, "").trim();
const CALLBACK_BASE_URL = (process.env.CALLBACK_BASE_URL || "https://your-domain.com").replace(/\/$/, "");

if (!MONGODB_URI) console.warn("⚠️ MONGODB_URI is not defined.");
if (!PAYHERO_API_KEY || !PAYHERO_CHANNEL_ID) console.warn("⚠️ PayHero API configurations missing.");

// --- MONGODB CONNECTION ---
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
      .then(() => console.log('✅ MongoDB Connected Successfully'))
      .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userName: { type: String, required: true },
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const depositSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    reference: { type: String, required: true },
    checkoutRequestId: { type: String },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

const taxPaymentSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    reference: { type: String, required: true },
    checkoutRequestId: { type: String },
    status: { type: String, default: "Pending" },
    isUsed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const TaxPayment = mongoose.model('TaxPayment', taxPaymentSchema);

const withdrawalSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- HELPER FUNCTION ---
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
    else if (cleaned.startsWith('7') || cleaned.startsWith('1')) cleaned = '254' + cleaned;
    return cleaned;
}

// --- AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized." });
    try {
        req.user = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid or expired token." });
    }
};

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        if (await User.findOne({ phone })) return res.status(400).json({ message: "Phone registered." });
        const newUser = new User({ phone, password: await bcrypt.hash(password, 10), userName: name });
        await newUser.save();
        res.status(201).json({ success: true, token: jwt.sign({ userId: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '7d' }), user: newUser });
    } catch (err) { res.status(500).json({ message: "Server error." }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone });
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) return res.status(400).json({ message: "Invalid credentials." });
        res.json({ success: true, token: jwt.sign({ userId: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' }), user });
    } catch (err) { res.status(500).json({ message: "Server error." }); }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    const user = await User.findById(req.user.userId);
    res.json(user ? { success: true, user } : { message: "User not found." });
});

// --- BET AND BALANCE SYNC ROUTES ---
app.post('/api/user/bet', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const amount = Number(req.body.amount);
        if (!user || user.balance < amount) return res.status(400).json({ message: "Insufficient balance." });
        user.balance -= amount;
        await user.save();
        res.json({ success: true, balance: user.balance });
    } catch (err) { res.status(500).json({ message: "Server error." }); }
});

app.post('/api/user/win', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const amount = Number(req.body.amount);
        if (!user) return res.status(404).json({ message: "User not found." });
        user.balance += amount;
        await user.save();
        res.json({ success: true, balance: user.balance });
    } catch (err) { res.status(500).json({ message: "Server error." }); }
});


// --- PAYHERO STK PUSH & WEBHOOK ROUTES ---

// PayHero Webhook Callback Handler
app.post('/api/payhero/callback', async (req, res) => {
    try {
        const payload = req.body;
        console.log("🔔 PayHero Webhook Received:", JSON.stringify(payload));
        
        // Ensure robust extraction from various Safaricom/PayHero callback structures
        const stkCallback = payload?.Body?.stkCallback || payload?.stkCallback || payload;
        const checkoutRequestId = stkCallback.CheckoutRequestID || payload.CheckoutRequestID;
        const externalReference = payload.ExternalReference || payload.external_reference;
        const resultCode = stkCallback.ResultCode !== undefined ? stkCallback.ResultCode : payload.ResultCode;
        
        const isSuccess = (resultCode === 0 || resultCode === "0" || String(payload.status).toLowerCase() === "success");

        let deposit = null;
        let tax = null;

        if (externalReference) {
             deposit = await Deposit.findOne({ reference: externalReference });
             if (!deposit) tax = await TaxPayment.findOne({ reference: externalReference });
        } 
        if (!deposit && !tax && checkoutRequestId) {
             deposit = await Deposit.findOne({ checkoutRequestId });
             if (!deposit) tax = await TaxPayment.findOne({ checkoutRequestId });
        }

        if (deposit && deposit.status === "Pending") {
            if (isSuccess) {
                deposit.status = "Successful";
                await deposit.save();
                const user = await User.findOne({ phone: deposit.userPhone });
                if (user) {
                    user.balance += deposit.amount; 
                    await user.save();
                    io.emit("balanceUpdated", { userPhone: user.phone, newBalance: user.balance });
                }
            } else {
                deposit.status = "Failed";
                await deposit.save();
            }
        } else if (tax && tax.status === "Pending") {
            tax.status = isSuccess ? "Successful" : "Failed";
            await tax.save();
        }

        // Always acknowledge receipt to prevent PayHero from retrying unnecessarily
        res.status(200).json({ success: true, message: "Callback processed successfully" });
    } catch (err) {
        console.error("❌ Callback Processing Error:", err);
        res.status(500).send("Error");
    }
});

// Deposit Route
app.post('/api/deposit/stkpush', authenticateToken, async (req, res) => {
    try {
        const depositAmount = Number(req.body.amount);
        if (!depositAmount || depositAmount < 500) return res.status(400).json({ message: "Minimum deposit is 500 KES." });

        const depositTax = Math.ceil(depositAmount * 0.15); 
        const totalAmountToPay = depositAmount + depositTax; 
        const reference = `DEP_${Date.now()}`;
        const formattedPhone = formatPhoneNumber(req.user.phone);

        const newDeposit = new Deposit({ userPhone: req.user.phone, phone: formattedPhone, amount: depositAmount, reference });
        await newDeposit.save();

        const response = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Authorization": `Basic ${PAYHERO_API_KEY}` 
            },
            body: JSON.stringify({
                amount: totalAmountToPay,
                phone_number: formattedPhone,
                channel_id: Number(PAYHERO_CHANNEL_ID),
                provider: "m-pesa",
                external_reference: reference,
                callback_url: `${CALLBACK_BASE_URL}/api/payhero/callback`
            })
        });

        const data = await response.json();
        if (response.ok && (data.success || data.CheckoutRequestID)) {
            newDeposit.checkoutRequestId = data.CheckoutRequestID || data.data?.checkout_request_id;
            await newDeposit.save();
            return res.json({ success: true, reference, message: `STK Push sent to ${formattedPhone}!` });
        } else {
            console.error("❌ PayHero Deposit API Rejection:", response.status, data); 

            newDeposit.status = "Failed";
            await newDeposit.save();
            return res.status(400).json({ message: data.message || "Request rejected." });
        }
    } catch (err) { 
        console.error("Deposit Error:", err);
        res.status(500).json({ message: "Error triggering deposit." }); 
    }
});

// Tax Payment Route
app.post('/api/tax/stkpush', authenticateToken, async (req, res) => {
    try {
        const requestedWithdrawal = Number(req.body.withdrawalAmount);
        if (!requestedWithdrawal || requestedWithdrawal < 4000) {
            return res.status(400).json({ message: "Minimum withdrawal is 4000 KES." });
        }

        const taxAmount = Math.ceil(requestedWithdrawal * 0.20);
        const formattedPhone = formatPhoneNumber(req.body.phone || req.user.phone);
        const reference = `TAX_${Date.now()}`;

        const newTax = new TaxPayment({ userPhone: req.user.phone, phone: formattedPhone, amount: taxAmount, reference });
        await newTax.save();

        const response = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "Authorization": `Basic ${PAYHERO_API_KEY}` 
            },
            body: JSON.stringify({
                amount: taxAmount,
                phone_number: formattedPhone,
                channel_id: Number(PAYHERO_CHANNEL_ID),
                provider: "m-pesa",
                external_reference: reference,
                callback_url: `${CALLBACK_BASE_URL}/api/payhero/callback`
            })
        });

        const data = await response.json();
        if (response.ok && (data.success || data.CheckoutRequestID)) {
            newTax.checkoutRequestId = data.CheckoutRequestID || data.data?.checkout_request_id;
            await newTax.save();
            return res.json({ success: true, reference, taxAmount, message: `Tax payment prompt sent!` });
        } else {
            console.error("❌ PayHero Tax API Rejection:", response.status, data);

            newTax.status = "Failed";
            await newTax.save();
            return res.status(400).json({ message: "Tax payment request rejected." });
        }
    } catch (err) { res.status(500).json({ message: "Error triggering tax payment." }); }
});

// Realtime Status Checking (Frontend Polling)
app.get('/api/deposit/status/:reference', authenticateToken, async (req, res) => {
    try {
        const deposit = await Deposit.findOne({ reference: req.params.reference });
        if (!deposit) return res.status(404).json({ message: "Transaction not found." });
        res.json({ success: true, status: deposit.status });
    } catch (err) { res.status(500).json({ message: "Error checking status." }); }
});

app.get('/api/tax/status/:reference', authenticateToken, async (req, res) => {
    try {
        const tax = await TaxPayment.findOne({ reference: req.params.reference });
        if (!tax) return res.status(404).json({ message: "Tax transaction not found." });
        res.json({ success: true, status: tax.status });
    } catch (err) { res.status(500).json({ message: "Error checking tax status." }); }
});

// --- HTTP WITHDRAWAL PROCESSING ---
app.post('/api/withdrawals/request', authenticateToken, async (req, res) => {
    try {
        const amount = Number(req.body.amount);
        const user = await User.findById(req.user.userId);
        if (amount < 4000) return res.status(400).json({ message: "Minimum withdrawal is 4000 KES." });
        if (!user || user.balance < amount) return res.status(400).json({ message: "Insufficient balance." });
        
        const successfulTax = await TaxPayment.findOne({ userPhone: req.user.phone, status: "Successful", isUsed: false });
        if (!successfulTax) return res.status(400).json({ message: "Upfront tax must be paid before withdrawal." });

        successfulTax.isUsed = true;
        await successfulTax.save();
        user.balance -= amount;
        await user.save();
        
        const withdrawal = new Withdrawal({ userPhone: user.phone, phone: user.phone, amount, status: "Pending" });
        await withdrawal.save();
        
        res.json({ success: true, message: "Withdrawal request received.", newBalance: user.balance });
    } catch (err) { res.status(500).json({ message: "Error processing withdrawal." }); }
});

app.get('/api/deposits/history', authenticateToken, async (req, res) => {
    try {
        const deposits = await Deposit.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, deposits });
    } catch (err) { res.status(500).json({ message: "Error fetching deposit history." }); }
});

app.get('/api/withdrawals/history', authenticateToken, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, withdrawals });
    } catch (err) { res.status(500).json({ message: "Error fetching withdrawal history." }); }
});

// --- GAME SERVER & SOCKET ENGINE ---
let gameState = { currentOdd: 1.00, crashPoint: 1.00, isFlying: false };
let oddsHistory = [1.06, 2.19, 5.51, 1.45, 3.20]; 

let intervalCount = 0;
let forcedRoundsRemaining = 0;
let targetMinMultiplier = 1.00;

setInterval(() => {
    intervalCount++;
    if (intervalCount > 6) intervalCount = 1; 

    if (intervalCount === 1) { forcedRoundsRemaining = 2; targetMinMultiplier = 90.00; }
    else if (intervalCount === 2) { forcedRoundsRemaining = 4; targetMinMultiplier = 30.00; }
    else if (intervalCount === 3) { forcedRoundsRemaining = 3; targetMinMultiplier = 60.00; }
    else if (intervalCount === 4) { forcedRoundsRemaining = 2; targetMinMultiplier = 40.00; } 
    else if (intervalCount === 5) { forcedRoundsRemaining = 5; targetMinMultiplier = 20.00; } 
    else if (intervalCount === 6) { forcedRoundsRemaining = 1; targetMinMultiplier = 100.00; } 
}, 1200000);

function determineCrashPoint() {
    if (forcedRoundsRemaining > 0) {
        forcedRoundsRemaining--;
        return parseFloat((targetMinMultiplier + (Math.random() * 5)).toFixed(2));
    }
    
    let r = Math.random();
    let crash;
    if (r < 0.08) crash = 1.00; 
    else if (r < 0.60) crash = 1.01 + (Math.random() * 1.49); 
    else if (r < 0.85) crash = 2.50 + (Math.random() * 2.50); 
    else if (r < 0.96) crash = 5.00 + (Math.random() * 5.00); 
    else crash = 10.00 + (Math.random() * 10.00); 

    return parseFloat(Math.min(crash, 20.00).toFixed(2));
}

function runGameLoop() {
    gameState.crashPoint = determineCrashPoint();
    gameState.currentOdd = 1.00;
    gameState.isFlying = true;
    io.emit("takeoff");

    const gameInterval = setInterval(() => {
        if (gameState.currentOdd >= gameState.crashPoint) {
            clearInterval(gameInterval);
            gameState.isFlying = false;
            oddsHistory.push(gameState.crashPoint);
            if (oddsHistory.length > 10) oddsHistory.shift(); 
            io.emit("crash", { finalOdd: gameState.crashPoint });
            setTimeout(runGameLoop, 5000); 
        } else {
            gameState.currentOdd = parseFloat((gameState.currentOdd + 0.03).toFixed(2));
            io.emit("tick", { currentOdd: gameState.currentOdd });
        }
    }, 100);
}
runGameLoop();

// Chat bot logic initialized here...
const botMessages = [
    "Alex: Just cashed out 500 KES! 💸",
    "Sarah: Waiting for 90x 🚀",
    "Kevo: Wow, crashed so fast 😭",
    "sharon: Pesa zimeingia 🎉."
];

setInterval(() => {
    const randomMsg = botMessages[Math.floor(Math.random() * botMessages.length)];
    io.emit("chat message", randomMsg);
}, 8000); 

io.on("connection", (socket) => {
    socket.emit("sync", { currentOdd: gameState.currentOdd, isFlying: gameState.isFlying, history: oddsHistory });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Server running on port ${PORT}`);
});
    
