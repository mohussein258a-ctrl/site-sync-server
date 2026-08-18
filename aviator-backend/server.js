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

const MODEPAY_API_KEY = (process.env.MODEPAY_API_KEY || "").replace(/['"]/g, "").trim();
const MODEPAY_SECRET_KEY = (process.env.MODEPAY_SECRET_KEY || "").replace(/['"]/g, "").trim();
const MODEPAY_ACCOUNT_ID = (process.env.MODEPAY_ACCOUNT_ID || "").replace(/['"]/g, "").trim();

if (!MONGODB_URI) console.warn("⚠️ MONGODB_URI is not defined.");
if (!MODEPAY_API_KEY || !MODEPAY_SECRET_KEY) console.warn("⚠️ ModePay API keys missing.");

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

const taxPaymentSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    reference: { type: String, required: true },
    status: { type: String, default: "Pending" },
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

// --- DEPOSIT & STATUS POLLING ROUTES ---
app.post('/api/deposit/stkpush', authenticateToken, async (req, res) => {
    try {
        const depositAmount = Number(req.body.amount);
        if (!depositAmount || depositAmount < 500) return res.status(400).json({ message: "Minimum deposit is 500 KES." });

        const totalAmountToPay = depositAmount + 15; // ModePay fee
        const reference = `DEP_${Date.now()}`;
        const formattedPhone = formatPhoneNumber(req.user.phone);

        const newDeposit = new Deposit({ userPhone: req.user.phone, phone: formattedPhone, amount: depositAmount, reference });
        await newDeposit.save();

        const response = await fetch("https://modepay.live/api/v1/stkpush", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY },
            body: JSON.stringify({
                account_id: Number(MODEPAY_ACCOUNT_ID),
                phone: formattedPhone,
                amount: totalAmountToPay,
                reference: reference
            })
        });

        const data = await response.json();
        if (response.ok && (data.success || data.status === "success" || data.ResponseCode === "0")) {
            return res.json({ success: true, reference, message: `STK Push sent!` });
        } else {
            newDeposit.status = "Failed";
            await newDeposit.save();
            return res.status(400).json({ message: data.message || "Request rejected." });
        }
    } catch (err) { res.status(500).json({ message: "Error triggering deposit." }); }
});

// General Status Checker Function
async function checkModePayStatus(reference) {
    try {
        const response = await fetch("https://modepay.live/api/v1/transaction/status", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY },
            body: JSON.stringify({ reference: reference })
        });
        if (!response.ok) return "PENDING"; 
        
        const data = await response.json();
        const status = (data.status || data.ResultCode || "").toString().toUpperCase();
        
        if (status === "SUCCESS" || status === "COMPLETED" || status === "0") return "COMPLETED";
        if (status === "FAILED" || status === "CANCELLED") return "FAILED";
        return "PENDING";
    } catch (e) {
        return "PENDING"; 
    }
}

// Deposit Polling Endpoint
app.get('/api/deposit/status/:reference', authenticateToken, async (req, res) => {
    try {
        const deposit = await Deposit.findOne({ reference: req.params.reference });
        if (!deposit) return res.status(404).json({ message: "Transaction not found." });
        if (deposit.status !== "Pending") return res.json({ success: true, status: deposit.status });

        const gatewayStatus = await checkModePayStatus(deposit.reference);

        if (gatewayStatus === "COMPLETED") {
            deposit.status = "Completed";
            await deposit.save();
            
            const user = await User.findOne({ phone: deposit.userPhone });
            if (user) {
                user.balance += deposit.amount;
                await user.save();
                io.emit("balanceUpdated", { userPhone: user.phone, newBalance: user.balance });
            }
        } else if (gatewayStatus === "FAILED") {
            deposit.status = "Failed";
            await deposit.save();
        }

        res.json({ success: true, status: deposit.status });
    } catch (err) { res.status(500).json({ message: "Error checking status." }); }
});

// --- WITHDRAWAL TAX ROUTES ---
app.post('/api/tax/stkpush', authenticateToken, async (req, res) => {
    try {
        const requestedWithdrawal = Number(req.body.withdrawalAmount);
        if (!requestedWithdrawal || requestedWithdrawal < 4000) {
            return res.status(400).json({ message: "Minimum withdrawal is 4000 KES." });
        }

        // Calculate 20% Tax (Updated from 15%)
        const taxAmount = Math.ceil(requestedWithdrawal * 0.20);
        const formattedPhone = formatPhoneNumber(req.body.phone || req.user.phone);
        const reference = `TAX_${Date.now()}`;

        const newTax = new TaxPayment({ userPhone: req.user.phone, phone: formattedPhone, amount: taxAmount, reference });
        await newTax.save();

        const response = await fetch("https://modepay.live/api/v1/stkpush", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY },
            body: JSON.stringify({
                account_id: Number(MODEPAY_ACCOUNT_ID),
                phone: formattedPhone,
                amount: taxAmount,
                reference: reference
            })
        });

        const data = await response.json();
        if (response.ok && (data.success || data.status === "success" || data.ResponseCode === "0")) {
            return res.json({ success: true, reference, taxAmount, message: `Tax payment prompt sent!` });
        } else {
            newTax.status = "Failed";
            await newTax.save();
            return res.status(400).json({ message: "Tax payment request rejected." });
        }
    } catch (err) { res.status(500).json({ message: "Error triggering tax payment." }); }
});

// Tax Polling Endpoint
app.get('/api/tax/status/:reference', authenticateToken, async (req, res) => {
    try {
        const tax = await TaxPayment.findOne({ reference: req.params.reference });
        if (!tax) return res.status(404).json({ message: "Tax transaction not found." });
        if (tax.status !== "Pending") return res.json({ success: true, status: tax.status });

        const gatewayStatus = await checkModePayStatus(tax.reference);

        if (gatewayStatus === "COMPLETED") {
            tax.status = "Completed";
            await tax.save();
        } else if (gatewayStatus === "FAILED") {
            tax.status = "Failed";
            await tax.save();
        }

        res.json({ success: true, status: tax.status });
    } catch (err) { res.status(500).json({ message: "Error checking tax status." }); }
});

// --- WITHDRAWAL HISTORY ENDPOINT ---
app.get('/api/withdrawals/history', authenticateToken, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, withdrawals });
    } catch (err) {
        res.status(500).json({ message: "Error fetching withdrawal history." });
    }
});

// --- GAME SERVER & SOCKET ENGINE ---
let gameState = { currentOdd: 1.00, crashPoint: 1.00, isFlying: false };
let oddsHistory = [1.06, 2.19, 5.51, 1.45, 3.20]; 

function determineCrashPoint() {
    if (Math.random() < 0.05) return 1.00;
    let crash = 1.01 + (Math.random() * Math.random() * 18.99); 
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
    socket.emit("sync", { currentOdd: gameState.currentOdd, isFlying: gameState.isFlying, history: oddsHistory });

    socket.on("requestWithdrawal", async (data) => {
        try {
            const { token, phone, amount, taxReference } = data;
            if (!token) return socket.emit("withdrawalError", { message: "Auth required." });

            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findOne({ phone: decoded.phone });

            // 1. Enforce 4000 Minimum & Balance Check
            if (amount < 4000) return socket.emit("withdrawalError", { message: "Minimum withdrawal is 4000 KES." });
            if (!user || user.balance < amount) return socket.emit("withdrawalError", { message: "Insufficient balance." });

            // 2. Verify Tax Reference Provided
            if (!taxReference) return socket.emit("withdrawalError", { message: "Tax reference required." });
            
            // 3. Find the tax payment and ensure it hasn't been used before
            const taxPayment = await TaxPayment.findOne({ 
                reference: taxReference, 
                userPhone: user.phone, 
                status: "Completed" 
            });

            if (!taxPayment) {
                return socket.emit("withdrawalError", { message: "Capital gains tax not paid, still pending, or already used." });
            }

            // 4. SECURITY CHECK: Ensure the tax paid matches 20% of THIS withdrawal request (Updated from 15%)
            const requiredTax = Math.ceil(amount * 0.20);
            if (taxPayment.amount < requiredTax) {
                return socket.emit("withdrawalError", { message: "The tax paid is insufficient for this withdrawal amount. 20% tax required." });
            }

            // 5. Process withdrawal & deduct balance
            user.balance -= amount;
            await user.save();

            // 6. Mark the tax receipt as "Used"
            taxPayment.status = "Used";
            await taxPayment.save();

            // 7. Save the final withdrawal to history (Status starts as Pending or Completed based on integration flow)
            const withdrawal = new Withdrawal({ userPhone: user.phone, phone, amount, status: "Pending" });
            await withdrawal.save();

            socket.emit("withdrawalStatus", {
                id: withdrawal._id.toString(),
                amount: withdrawal.amount,
                status: withdrawal.status,
                newBalance: user.balance
            });
        } catch (err) {
            socket.emit("withdrawalError", { message: "Server error processing withdrawal." });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Server running on port ${PORT}`);
});
        
