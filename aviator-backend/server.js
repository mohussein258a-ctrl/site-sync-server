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

// Enable trust proxy so Render passes HTTPS protocols cleanly
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// --- ENVIRONMENT CONFIGURATION ---
const JWT_SECRET = process.env.JWT_SECRET || "pilot_hamoody_secret_key_2026";
const MONGODB_URI = process.env.MONGODB_URI;

// Automatically trim spaces, quotes, or trailing characters from keys
const MODEPAY_API_KEY = (process.env.MODEPAY_API_KEY || "").replace(/['"]/g, "").trim();
const MODEPAY_SECRET_KEY = (process.env.MODEPAY_SECRET_KEY || "").replace(/['"]/g, "").trim();
const MODEPAY_ACCOUNT_ID = (process.env.MODEPAY_ACCOUNT_ID || "").replace(/['"]/g, "").trim();

if (!MONGODB_URI) console.warn("⚠️ MONGODB_URI is not defined.");
if (!MODEPAY_API_KEY || !MODEPAY_SECRET_KEY) console.warn("⚠️ ModePay API keys missing.");
if (!MODEPAY_ACCOUNT_ID) console.warn("⚠️ MODEPAY_ACCOUNT_ID missing.");

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
    amount: { type: Number, required: true },       // Base deposit amount
    tax: { type: Number, required: true },          // 15% tax fee
    totalAmount: { type: Number, required: true },  // Total requested from M-Pesa
    reference: { type: String, required: true },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

const withdrawalSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },      // Gross requested amount
    tax: { type: Number, required: true },         // 20% withheld
    netAmount: { type: Number, required: true },   // Amount to actually send
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- HELPER FUNCTION: FORMAT PHONE ---
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.slice(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }
    return cleaned;
}

// --- AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Unauthorized: No token provided." });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid or expired token." });
    }
};

// --- AUTH & USER ROUTES ---
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        if (!phone || !password || !name) return res.status(400).json({ message: "Missing fields." });

        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ message: "Phone number already registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ phone, password: hashedPassword, userName: name });
        await newUser.save();

        const token = jwt.sign({ userId: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ success: true, token, user: { phone: newUser.phone, name: newUser.userName, balance: newUser.balance } });
    } catch (err) {
        res.status(500).json({ message: "Server error during registration." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) return res.status(400).json({ message: "Phone and password required." });

        const user = await User.findOne({ phone });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: "Invalid credentials." });

        const token = jwt.sign({ userId: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, token, user: { phone: user.phone, name: user.userName, balance: user.balance } });
    } catch (err) {
        res.status(500).json({ message: "Server error during login." });
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found." });
        res.json({ success: true, user: { phone: user.phone, name: user.userName, balance: user.balance } });
    } catch (err) {
        res.status(500).json({ message: "Server error checking session." });
    }
});

// --- MODEPAY DEPOSIT ROUTES ---
app.post('/api/deposit/stkpush', authenticateToken, async (req, res) => {
    try {
        const depositAmount = Number(req.body.amount);

        if (!depositAmount || depositAmount < 500) {
            return res.status(400).json({ message: "Minimum deposit is 500 KES." });
        }

        // 15% Deposit Tax Calculation
        const transactionFee = depositAmount * 0.15;
        const totalAmountToPay = depositAmount + transactionFee;

        const userPhone = req.user.phone;
        const formattedPhone = formatPhoneNumber(userPhone);
        const accountId = Number(MODEPAY_ACCOUNT_ID);

        const reference = `DEP_${Date.now()}`;

        const newDeposit = new Deposit({
            userPhone: userPhone,
            phone: formattedPhone,
            amount: depositAmount, 
            tax: transactionFee,
            totalAmount: totalAmountToPay,
            reference: reference,
            status: "Pending"
        });
        await newDeposit.save();

        const response = await fetch("https://modepay.live/api/v1/stkpush", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": MODEPAY_API_KEY,
                "X-API-Secret": MODEPAY_SECRET_KEY
            },
            body: JSON.stringify({
                account_id: accountId,
                phone: formattedPhone,
                amount: totalAmountToPay,
                reference: reference,
                callback_url: `https://${req.get('host')}/api/deposit/callback`
            })
        });

        const data = await response.json();

        if (response.ok && (data.success || data.status === "success" || data.ResponseCode === "0")) {
            return res.json({ 
                success: true, 
                reference: reference, 
                taxAmount: transactionFee, // Used for frontend UI display
                totalAmount: totalAmountToPay,
                message: `M-Pesa STK Push sent! Total: ${totalAmountToPay} KES. Enter PIN.` 
            });
        } else {
            newDeposit.status = "Failed";
            await newDeposit.save();
            return res.status(400).json({ message: data.message || "ModePay API request rejected." });
        }
    } catch (err) {
        res.status(500).json({ message: "Server error triggering STK push." });
    }
});

// Polling Endpoint for Frontend to Check Status
app.post('/api/deposit/verify', authenticateToken, async (req, res) => {
    try {
        const { reference } = req.body;
        if (!reference) return res.status(400).json({ message: "Reference required." });

        const deposit = await Deposit.findOne({ reference, userPhone: req.user.phone });
        if (!deposit) return res.status(404).json({ message: "Deposit not found." });

        // If already completed/failed in DB, return immediately
        if (deposit.status !== "Pending") {
            const user = await User.findOne({ phone: req.user.phone });
            return res.json({ status: deposit.status, balance: user.balance });
        }

        // Poll ModePay for the actual status
        const response = await fetch("https://modepay.live/api/v1/transaction/status", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": MODEPAY_API_KEY,
                "X-API-Secret": MODEPAY_SECRET_KEY
            },
            body: JSON.stringify({ reference: reference })
        });

        const data = await response.json();
        const status = (data.status || data.ResultCode || data.resultCode || "").toString().toUpperCase();

        const isSuccess = status === "SUCCESS" || status === "0" || status === "COMPLETED";
        const isFailed = status === "FAILED" || status === "CANCELLED";

        if (isSuccess) {
            deposit.status = "Completed";
            await deposit.save();

            const user = await User.findOne({ phone: deposit.userPhone });
            user.balance += deposit.amount; // Only credit the base amount, not the tax
            await user.save();
            
            io.emit("balanceUpdated", { userPhone: user.phone, newBalance: user.balance });
            return res.json({ status: "Completed", balance: user.balance });
        } else if (isFailed) {
            deposit.status = "Failed";
            await deposit.save();
            return res.json({ status: "Failed" });
        }

        // Still pending
        return res.json({ status: "Pending" });

    } catch (err) {
        res.status(500).json({ message: "Verification error." });
    }
});

// Fallback Callback Webhook
app.post('/api/deposit/callback', async (req, res) => {
    try {
        const payload = req.body || {};
        const status = (payload.status || payload.ResultCode || "").toString().toUpperCase();
        const reference = payload.reference || payload.mpesaReceiptNumber || payload.CheckoutRequestID;
        const isSuccess = status === "SUCCESS" || status === "0" || status === "COMPLETED";

        if (!reference) return res.status(400).json({ message: "No reference provided" });

        const depositRecord = await Deposit.findOne({ reference });
        if (!depositRecord || depositRecord.status !== "Pending") {
            return res.status(200).json({ ResponseCode: 0, ResponseDesc: "Acknowledged" });
        }

        if (isSuccess) {
            depositRecord.status = "Completed";
            await depositRecord.save();

            const user = await User.findOne({ phone: depositRecord.userPhone });
            if (user) {
                user.balance += depositRecord.amount; // Only credit the base amount
                await user.save();
                io.emit("balanceUpdated", { userPhone: user.phone, newBalance: user.balance });
            }
        } else {
            depositRecord.status = "Failed";
            await depositRecord.save();
        }
        res.status(200).json({ ResponseCode: 0, ResponseDesc: "Success" });
    } catch (err) {
        res.status(500).json({ message: "Callback failed." });
    }
});

// --- HISTORY ROUTES ---
app.get('/api/deposits', authenticateToken, async (req, res) => {
    try {
        const deposits = await Deposit.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        const formattedDeposits = deposits.map(d => ({
            _id: d._id, amount: d.amount, tax: d.tax, totalAmount: d.totalAmount, status: d.status, reference: d.reference,
            timestamp: new Date(d.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));
        res.json({ success: true, deposits: formattedDeposits });
    } catch (err) { res.status(500).json({ message: "Error fetching deposit history." }); }
});

app.get('/api/withdrawals', authenticateToken, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        const formattedWithdrawals = withdrawals.map(w => ({
            _id: w._id, amount: w.amount, tax: w.tax, netAmount: w.netAmount, status: w.status,
            timestamp: new Date(w.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));
        res.json({ success: true, withdrawals: formattedWithdrawals });
    } catch (err) { res.status(500).json({ message: "Error fetching withdrawals." }); }
});

// --- GAME SERVER ENGINE ---
let gameState = { currentOdd: 1.00, crashPoint: 1.00, isFlying: false };
let oddsHistory = [1.06, 2.19, 5.51, 1.45, 3.20]; 
let intervalCount = 0;
let forcedRoundsRemaining = 0;
let targetMinMultiplier = 1.00;

setInterval(() => {
    intervalCount++;
    if (intervalCount > 3) intervalCount = 1; 

    if (intervalCount === 1) { forcedRoundsRemaining = 2; targetMinMultiplier = 90.00; }
    else if (intervalCount === 2) { forcedRoundsRemaining = 4; targetMinMultiplier = 30.00; }
    else if (intervalCount === 3) { forcedRoundsRemaining = 3; targetMinMultiplier = 60.00; }
}, 1200000);

function determineCrashPoint() {
    if (forcedRoundsRemaining > 0) {
        forcedRoundsRemaining--;
        return parseFloat((targetMinMultiplier + (Math.random() * 5)).toFixed(2));
    }
    if (Math.random() < 0.05) return 1.00;
    let crash = 1.01 + (Math.random() * Math.random() * 18.99); 
    if (crash > 20.00) crash = 20.00;
    return parseFloat(crash.toFixed(2));
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

setInterval(() => {
    const botMessages = ["Alex: Just cashed out 500 KES! 💸", "Sarah: Waiting for 10x 🚀", "Mwangi: Nice win right there."];
    io.emit("chat message", botMessages[Math.floor(Math.random() * botMessages.length)]);
}, 5000); 

// --- SOCKET EVENTS ---
io.on("connection", (socket) => {
    socket.emit("sync", { currentOdd: gameState.currentOdd, isFlying: gameState.isFlying, history: oddsHistory });
    socket.on("chat message", (data) => io.emit("chat message", data));

    // --- WITHDRAWAL LOGIC ---
    socket.on("requestWithdrawal", async (data) => {
        try {
            const { token, phone, amount } = data;
            if (!token) return socket.emit("withdrawalError", { message: "Auth required." });

            if (amount < 4500) {
                return socket.emit("withdrawalError", { message: "Minimum withdrawal is 4,500 KES." });
            }

            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findOne({ phone: decoded.phone });

            if (!user || user.balance < amount) {
                return socket.emit("withdrawalError", { message: "Insufficient balance." });
            }

            // Calculate 20% Tax
            const tax = amount * 0.20;
            const netAmount = amount - tax;

            // Deduct gross amount immediately to prevent double spending
            user.balance -= amount;
            await user.save();

            const withdrawal = new Withdrawal({ 
                userPhone: user.phone, 
                phone, 
                amount: amount, 
                tax: tax, 
                netAmount: netAmount, 
                status: "Pending" 
            });
            await withdrawal.save();

            socket.emit("withdrawalStatus", {
                id: withdrawal._id.toString(),
                amount: withdrawal.amount,
                tax: withdrawal.tax,
                netAmount: withdrawal.netAmount,
                status: withdrawal.status,
                newBalance: user.balance,
                message: `Withdrawal initiated. Net amount of ${netAmount} KES (after ${tax} KES tax) will be processed.`
            });
        } catch (err) {
            socket.emit("withdrawalError", { message: "Server error processing withdrawal." });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Game Server running on port ${PORT}`);
});
                                                          
