const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

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

if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI is not defined in Render environment variables.");
}

if (!MODEPAY_API_KEY || !MODEPAY_SECRET_KEY) {
    console.warn("⚠️ ModePay API keys are missing or invalid in Render environment variables.");
}

if (!MODEPAY_ACCOUNT_ID) {
    console.warn("⚠️ MODEPAY_ACCOUNT_ID is missing in Render environment variables.");
}

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
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

const withdrawalSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- HELPER FUNCTION: FORMAT PHONE TO 2547XXXXXXXX ---
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
        if (!phone || !password || !name) {
            return res.status(400).json({ message: "Missing required fields." });
        }

        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ message: "Phone number already registered." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ phone, password: hashedPassword, userName: name });
        await newUser.save();

        const token = jwt.sign({ userId: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ 
            success: true, 
            token: token,
            user: { phone: newUser.phone, name: newUser.userName, balance: newUser.balance } 
        });
    } catch (err) {
        res.status(500).json({ message: "Server error during registration." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) {
            return res.status(400).json({ message: "Phone and password are required." });
        }

        const user = await User.findOne({ phone });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: "Invalid phone number or password." });
        }

        const token = jwt.sign({ userId: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ 
            success: true, 
            token: token,
            user: { phone: user.phone, name: user.userName, balance: user.balance } 
        });
    } catch (err) {
        res.status(500).json({ message: "Server error during login." });
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found." });

        res.json({
            success: true,
            user: { phone: user.phone, name: user.userName, balance: user.balance }
        });
    } catch (err) {
        res.status(500).json({ message: "Server error checking session." });
    }
});

app.post('/api/balance', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        if (typeof amount !== 'number') return res.status(400).json({ message: "Invalid amount." });

        const user = await User.findByIdAndUpdate(req.user.userId, { balance: amount }, { new: true });
        res.json({ success: true, balance: user.balance });
    } catch (err) {
        res.status(500).json({ message: "Error updating balance." });
    }
});

// --- MODEPAY M-PESA STK PUSH & CALLBACK ROUTES ---

// Trigger M-Pesa STK Push Prompt
app.post('/api/deposit/stkpush', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;

        // Minimum deposit enforced at 500 KES
        if (!amount || Number(amount) < 500) {
            return res.status(400).json({ message: "Minimum deposit is 500 KES." });
        }

        // Strictly enforce account's registered phone number from auth token
        const userPhone = req.user.phone;
        const formattedPhone = formatPhoneNumber(userPhone);
        const accountId = Number(MODEPAY_ACCOUNT_ID);

        if (!accountId || isNaN(accountId)) {
            return res.status(500).json({ message: "Server configuration error: Invalid or missing MODEPAY_ACCOUNT_ID." });
        }

        const reference = `DEP_${Date.now()}`;

        // Create pending deposit entry in database
        const newDeposit = new Deposit({
            userPhone: userPhone,
            phone: formattedPhone,
            amount: Number(amount),
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
                amount: Number(amount),
                reference: reference,
                callback_url: `https://${req.get('host')}/api/deposit/callback`
            })
        });

        const data = await response.json();
        console.log("ModePay Response Status:", response.status, JSON.stringify(data));

        if (response.ok && (data.success || data.status === "success" || data.ResponseCode === "0")) {
            return res.json({ success: true, message: "M-Pesa STK Push sent to your phone! Enter your PIN." });
        } else {
            newDeposit.status = "Failed";
            await newDeposit.save();
            const errMsg = data.message || data.error || data.ResponseDescription || data.msg || "ModePay API request rejected.";
            return res.status(400).json({ message: errMsg });
        }
    } catch (err) {
        console.error("ModePay STK Push Error:", err);
        res.status(500).json({ message: "Server error triggering STK push prompt." });
    }
});

// Callback Webhook to Credit User Balance & Update Transaction History
app.post('/api/deposit/callback', async (req, res) => {
    try {
        const payload = req.body || {};
        console.log("📥 ModePay Callback Received:", JSON.stringify(payload));

        const status = (payload.status || payload.ResultCode || payload.resultCode || "").toString().toUpperCase();
        const amount = Number(payload.amount || payload.Amount || payload.transAmount || 0);
        const phone = payload.phone || payload.PhoneNumber || payload.MSISDN || payload.msisdn;
        const reference = payload.reference || payload.mpesaReceiptNumber || payload.MpesaReceiptNumber || payload.CheckoutRequestID;

        const isSuccess = status === "SUCCESS" || status === "0" || status === "COMPLETED" || payload.ResultCode === 0;

        if (isSuccess && amount > 0) {
            let user = null;

            if (reference) {
                const depositRecord = await Deposit.findOne({ reference });
                if (depositRecord) {
                    depositRecord.status = "Completed";
                    await depositRecord.save();
                    user = await User.findOne({ phone: depositRecord.userPhone });
                }
            }

            if (!user && phone) {
                const cleanPhone = phone.toString().slice(-9);
                user = await User.findOne({ phone: { $regex: cleanPhone } });
            }

            if (user) {
                user.balance += amount;
                await user.save();
                console.log(`✅ Balance Credited: KES ${amount} to ${user.phone}. New Balance: KES ${user.balance}`);
                io.emit("balanceUpdated", { userPhone: user.phone, newBalance: user.balance });
            }
        }

        res.status(200).json({ ResponseCode: 0, ResponseDesc: "Success" });
    } catch (err) {
        console.error("Callback processing error:", err);
        res.status(500).json({ message: "Callback processing failed." });
    }
});

// --- DEPOSIT & WITHDRAWAL HISTORY ROUTES ---

app.get('/api/deposits', authenticateToken, async (req, res) => {
    try {
        const deposits = await Deposit.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        const formattedDeposits = deposits.map(d => ({
            _id: d._id,
            phone: d.phone,
            amount: d.amount,
            status: d.status,
            reference: d.reference,
            timestamp: new Date(d.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));

        res.json({ success: true, deposits: formattedDeposits });
    } catch (err) {
        res.status(500).json({ message: "Error fetching deposit history." });
    }
});

app.get('/api/withdrawals', authenticateToken, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        const formattedWithdrawals = withdrawals.map(w => ({
            _id: w._id,
            phone: w.phone,
            amount: w.amount,
            status: w.status,
            timestamp: new Date(w.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));

        res.json({ success: true, withdrawals: formattedWithdrawals });
    } catch (err) {
        res.status(500).json({ message: "Error fetching withdrawals." });
    }
});

// --- GAME SERVER & SOCKET ENGINE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

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

    const r = Math.random();
    let crash = 1.01 + (r * r * 18.99); 
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

// Chat Bot Messages
const botMessages = [
    "Alex: Just cashed out 500 KES! 💸", "Sarah: Waiting for 10x 🚀",
    "Kevo: Wow, crashed so fast 😭", "Mike: Let's goooo!",
    "Mwangi: Nice win right there.", "Kasim: cashed out 3500 😜."
];

setInterval(() => {
    const randomMsg = botMessages[Math.floor(Math.random() * botMessages.length)];
    io.emit("chat message", randomMsg);
}, 5000); 

// Socket Event Handlers
io.on("connection", (socket) => {
    socket.emit("sync", {
        currentOdd: gameState.currentOdd,
        isFlying: gameState.isFlying,
        history: oddsHistory
    });

    socket.on("chat message", (data) => io.emit("chat message", data));

    socket.on("requestWithdrawal", async (data) => {
        try {
            const { token, phone, amount } = data;
            if (!token) return socket.emit("withdrawalError", { message: "Auth required." });

            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findOne({ phone: decoded.phone });

            if (!user || user.balance < amount) {
                return socket.emit("withdrawalError", { message: "Insufficient balance." });
            }

            user.balance -= amount;
            await user.save();

            const withdrawal = new Withdrawal({ userPhone: user.phone, phone, amount, status: "Pending" });
            await withdrawal.save();

            socket.emit("withdrawalStatus", {
                id: withdrawal._id.toString(),
                phone: withdrawal.phone,
                amount: withdrawal.amount,
                status: withdrawal.status,
                timestamp: new Date(withdrawal.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
                newBalance: user.balance
            });
        } catch (err) {
            socket.emit("withdrawalError", { message: "Server error processing withdrawal." });
        }
    });
});

// --- SERVER LISTEN ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Game Server running on port ${PORT}`);
});
    
