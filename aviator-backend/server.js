const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// --- ENVIRONMENT CONFIGURATION ---
const JWT_SECRET = process.env.JWT_SECRET || "pilot_hamoody_secret_key_2026";
const MONGODB_URI = process.env.MONGODB_URI;
const MODEPAY_API_KEY = process.env.MODEPAY_API_KEY;
const MODEPAY_API_SECRET = process.env.MODEPAY_API_SECRET;

if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI is not defined in environment variables. Make sure to add it in Render.");
}

// --- MONGODB CONNECTION ---
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
      .then(() => console.log('✅ MongoDB Connected Successfully'))
      .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

// --- SCHEMAS & MODELS ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userName: { type: String, required: true },
    balance: { type: Number, default: 0, min: 0 }
});

const User = mongoose.model('User', userSchema);

const withdrawalSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- MIDDLEWARE: AUTHENTICATION ---
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

// --- AUTHENTICATION & BALANCE API ROUTES ---

// 1. Register
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        
        if (!phone || !password || !name) {
            return res.status(400).json({ message: "Missing required fields: phone, password, or name." });
        }

        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ message: "Phone number already registered." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ phone, password: hashedPassword, userName: name });
        await newUser.save();

        const token = jwt.sign(
            { userId: newUser._id, phone: newUser.phone }, 
            JWT_SECRET, 
            { expiresIn: '7d' }
        );

        res.status(201).json({ 
            success: true, 
            token: token,
            user: { phone: newUser.phone, name: newUser.userName, balance: newUser.balance } 
        });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ message: "Server error during registration.", error: err.message });
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        
        if (!phone || !password) {
            return res.status(400).json({ message: "Phone and password are required." });
        }

        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(400).json({ message: "Invalid phone number or password." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid phone number or password." });
        }

        const token = jwt.sign(
            { userId: user._id, phone: user.phone }, 
            JWT_SECRET, 
            { expiresIn: '7d' }
        );

        res.json({ 
            success: true, 
            token: token,
            user: { phone: user.phone, name: user.userName, balance: user.balance } 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: "Server error during login." });
    }
});

// 3. Get Current Session & Balance
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found." });

        res.json({
            success: true,
            user: { phone: user.phone, name: user.userName, balance: user.balance }
        });
    } catch (err) {
        res.status(500).json({ message: "Server error fetching user profile." });
    }
});

// 4. Update Balance
app.post('/api/balance', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        if (typeof amount !== 'number' || amount < 0) {
            return res.status(400).json({ message: "Invalid balance amount." });
        }

        const user = await User.findByIdAndUpdate(req.user.userId, { balance: amount }, { new: true });
        if (!user) return res.status(404).json({ message: "User not found" });

        res.json({ success: true, balance: user.balance });
    } catch (err) {
        res.status(500).json({ message: "Error updating balance." });
    }
});

// 5. Get Withdrawal History
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
        console.error("Error fetching withdrawals:", err);
        res.status(500).json({ message: "Error fetching withdrawal history." });
    }
});

// --- AUTOMATIC MODEPAY DEPOSIT ROUTES ---

// Trigger M-Pesa Prompt
app.post('/api/deposit/stkpush', authenticateToken, async (req, res) => {
    try {
        const { phone, amount } = req.body;

        if (!phone || !amount || amount < 10) {
            return res.status(400).json({ message: "Please enter a valid phone number and amount." });
        }

        // Format phone to 254XXXXXXXXX
        let formattedPhone = phone.trim().replace("+", "");
        if (formattedPhone.startsWith("0")) {
            formattedPhone = "254" + formattedPhone.slice(1);
        }

        const hostUrl = req.protocol + '://' + req.get('host');

        const response = await fetch("https://api.modepay.com/v1/stkpush", { 
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${MODEPAY_API_SECRET}`,
                "X-API-KEY": MODEPAY_API_KEY
            },
            body: JSON.stringify({
                phoneNumber: formattedPhone,
                amount: Number(amount),
                reference: `DEP_${req.user.userId}_${Date.now()}`,
                callbackUrl: `${hostUrl}/api/deposit/callback`
            })
        });

        const data = await response.json();

        if (response.ok || data.success) {
            return res.json({ 
                success: true, 
                message: "Prompt sent! Enter your M-Pesa PIN on your phone to complete deposit." 
            });
        } else {
            return res.status(400).json({ 
                success: false, 
                message: data.message || "Failed to trigger payment prompt. Please try again." 
            });
        }
    } catch (err) {
        console.error("STK Push Error:", err);
        res.status(500).json({ message: "Server error triggering payment prompt." });
    }
});

// ModePay Callback Listener
app.post('/api/deposit/callback', async (req, res) => {
    try {
        const { status, reference, amount } = req.body;

        if (status === "SUCCESS" || status === "COMPLETED") {
            const parts = reference ? reference.split("_") : [];
            const userId = parts[1];

            if (userId) {
                const updatedUser = await User.findByIdAndUpdate(
                    userId, 
                    { $inc: { balance: Number(amount) } },
                    { new: true }
                );

                console.log(`✅ KES ${amount} automatically credited to user ${updatedUser.phone}`);
            }
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error("ModePay Callback Error:", err);
        res.status(500).json({ error: "Callback processing failed." });
    }
});

// --- GAME SERVER & SOCKET ENGINE ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

let gameState = {
    currentOdd: 1.00,
    crashPoint: 1.00,
    isFlying: false
};

let activeBets = new Map();
let oddsHistory = [1.06, 2.19, 5.51, 1.45, 3.20]; 

let intervalCount = 0;
let forcedRoundsRemaining = 0;
let targetMinMultiplier = 1.00;

setInterval(() => {
    intervalCount++;
    if (intervalCount > 3) intervalCount = 1; 

    if (intervalCount === 1) {
        forcedRoundsRemaining = 2;
        targetMinMultiplier = 90.00;
        console.log("⏰ [SIGNAL TRIGGERED] Interval 1: Next 2 rounds > 90x");
    } else if (intervalCount === 2) {
        forcedRoundsRemaining = 4;
        targetMinMultiplier = 30.00;
        console.log("⏰ [SIGNAL TRIGGERED] Interval 2: Next 4 rounds > 30x");
    } else if (intervalCount === 3) {
        forcedRoundsRemaining = 3;
        targetMinMultiplier = 60.00;
        console.log("⏰ [SIGNAL TRIGGERED] Interval 3: Next 3 rounds > 60x");
    }
}, 1200000);

function determineCrashPoint() {
    if (forcedRoundsRemaining > 0) {
        forcedRoundsRemaining--;
        let forcedCrash = targetMinMultiplier + (Math.random() * 15);
        return parseFloat(forcedCrash.toFixed(2));
    }

    if (Math.random() < 0.05) {
        return 1.00;
    }

    const r = Math.random();
    let crash = 1.01 + (r * r * 19.00); 

    if (crash > 20.00) crash = 20.00;

    return parseFloat(crash.toFixed(2));
}

function runGameLoop() {
    activeBets.clear();
    gameState.crashPoint = determineCrashPoint();
    gameState.currentOdd = 1.00;
    gameState.isFlying = true;

    io.emit("takeoff", { crashPoint: gameState.crashPoint });

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

// Chat Simulation
const botMessages = [
    "Alex: Just cashed out 500 KES! 💸",
    "Sarah: Waiting for 10x 🚀",
    "Kevo: Wow, crashed so fast 😭",
    "Mike: Let's goooo!",
    "Joy: Who is betting high this round?",
    "Mwangi: Nice win right there.",
    "Mwendee: what a day 🎉.",
    "Walalka: waiting for the signals.",
    "katana: just received the withdrawal 😜.",
    "Seif: aisee, leo ni leo🔥.",
    "Kasim: cashed out 3500 😜.",
    "John: watu watengeze doo.",
    "Eddy: Don't just wait for signals.",
    "Sharon: huu mwaka ni wa kununua gari aisee 💯."
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

    socket.on("chat message", (data) => {
        io.emit("chat message", data);
    });

    socket.on("placeBet", async (data) => {
        try {
            const { token, amount } = data;
            if (!token || !amount || amount <= 0) return;

            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.userId);

            if (!user || user.balance < amount) {
                return socket.emit("betError", { message: "Insufficient balance." });
            }

            user.balance -= amount;
            await user.save();

            activeBets.set(socket.id, {
                userId: user._id,
                amount: amount,
                cashedOut: false
            });

            socket.emit("betConfirmed", { balance: user.balance, amount });
        } catch (err) {
            socket.emit("betError", { message: "Bet processing failed." });
        }
    });

    socket.on("cashOut", async (data) => {
        try {
            const bet = activeBets.get(socket.id);
            if (!bet || bet.cashedOut || !gameState.isFlying) return;

            bet.cashedOut = true;
            const multiplier = gameState.currentOdd;
            const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));

            const user = await User.findByIdAndUpdate(
                bet.userId, 
                { $inc: { balance: winAmount } }, 
                { new: true }
            );

            socket.emit("cashOutSuccess", {
                winAmount: winAmount,
                multiplier: multiplier,
                newBalance: user.balance
            });
        } catch (err) {
            socket.emit("cashOutError", { message: "Cashout failed." });
        }
    });

    socket.on("requestWithdrawal", async (data) => {
        try {
            const { token, phone, amount } = data;
            if (!token || !amount || amount <= 0) return;

            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.userId);

            if (!user) return;

            if (user.balance < amount) {
                return socket.emit("withdrawalError", { message: "Insufficient balance for withdrawal." });
            }

            user.balance -= amount;
            await user.save();

            const withdrawal = new Withdrawal({
                userPhone: user.phone,
                phone: phone,
                amount: amount,
                status: "Pending"
            });
            await withdrawal.save();

            const formattedTime = new Date(withdrawal.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

            socket.emit("withdrawalStatus", {
                id: withdrawal._id.toString(),
                phone: withdrawal.phone,
                amount: withdrawal.amount,
                status: withdrawal.status,
                timestamp: formattedTime,
                newBalance: user.balance
            });

        } catch (err) {
            console.error("Error saving withdrawal to MongoDB:", err);
            socket.emit("withdrawalError", { message: "Server error processing withdrawal." });
        }
    });
});

// --- SERVER INITIALIZATION ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Game Server running on port ${PORT}`);
});
                             
