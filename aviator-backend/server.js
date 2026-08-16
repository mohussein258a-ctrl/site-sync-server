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

// --- JWT & ENVIRONMENT CONFIGURATION ---
const JWT_SECRET = process.env.JWT_SECRET || "pilot_hamoody_secret_key_2026";
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI is not defined in environment variables. Make sure to add it in Render.");
}

// --- MONGODB CONNECTION ---
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
      .then(() => console.log('✅ MongoDB Connected Successfully'))
      .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

// --- DATABASE SCHEMAS ---

// 1. User Schema
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userName: { type: String, required: true },
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// 2. Withdrawal Schema
const withdrawalSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    phone: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: "Pending" },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// 3. Deposit Schema (Modepay M-Pesa)
const depositSchema = new mongoose.Schema({
    userPhone: { type: String, required: true },
    mpesaPhone: { type: String, required: true },
    amount: { type: Number, required: true },
    checkoutRequestId: { type: String, required: true }, 
    status: { type: String, default: "Pending" }, 
    createdAt: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);


// --- AUTHENTICATION & BALANCE API ROUTES ---

// 1. Account Registration
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

// 2. Account Login
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
app.get('/api/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Unauthorized: No token provided." });
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        res.json({
            success: true,
            user: { phone: user.phone, name: user.userName, balance: user.balance }
        });
    } catch (err) {
        res.status(401).json({ message: "Invalid or expired token." });
    }
});

// 4. Update Balance (Manual/Internal)
app.post('/api/balance', async (req, res) => {
    try {
        const { phone, amount } = req.body;
        const user = await User.findOneAndUpdate({ phone }, { balance: amount }, { new: true });
        if (!user) return res.status(404).json({ message: "User not found" });

        res.json({ success: true, balance: user.balance });
    } catch (err) {
        res.status(500).json({ message: "Error updating balance." });
    }
});

// 5. Get Withdrawal History
app.get('/api/withdrawals', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Unauthorized: No token provided." });
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const withdrawals = await Withdrawal.find({ userPhone: user.phone }).sort({ createdAt: -1 });

        const formattedWithdrawals = withdrawals.map(w => ({
            _id: w._id,
            phone: w.phone,
            amount: w.amount,
            status: w.status,
            timestamp: new Date(w.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));

        res.json({
            success: true,
            withdrawals: formattedWithdrawals
        });
    } catch (err) {
        console.error("Error fetching withdrawals:", err);
        res.status(500).json({ message: "Error fetching withdrawal history." });
    }
});


// --- MODEPAY DEPOSIT M-PESA INTEGRATION ---

const MODEPAY_API_KEY = process.env.MODEPAY_API_KEY || "YOUR_MODEPAY_API_KEY";
const MODEPAY_STK_URL = "https://api.modepay.com/v1/checkout/stk"; 
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://your-production-url.onrender.com/api/deposit/webhook"; 

// 6. Initiate M-Pesa STK Push
app.post('/api/deposit/prompt', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Unauthorized." });
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const { mpesaPhone, amount } = req.body;

        if (amount < 500) {
            return res.status(400).json({ message: "Minimum deposit is 500 KES." });
        }

        let formattedPhone = mpesaPhone.startsWith("0") ? "254" + mpesaPhone.substring(1) : mpesaPhone;

        const response = await fetch(MODEPAY_STK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MODEPAY_API_KEY}`
            },
            body: JSON.stringify({
                phoneNumber: formattedPhone,
                amount: amount,
                callbackUrl: WEBHOOK_URL,
                reference: `DEP_${Date.now()}`,
                description: "Wallet Deposit"
            })
        });

        const data = await response.json();

        if (response.ok && data.checkoutRequestId) {
            const newDeposit = new Deposit({
                userPhone: decoded.phone,
                mpesaPhone: formattedPhone,
                amount: amount,
                checkoutRequestId: data.checkoutRequestId,
                status: "Pending"
            });
            await newDeposit.save();

            res.json({ success: true, message: "Prompt sent! Check your phone to enter PIN." });
        } else {
            res.status(400).json({ message: "Failed to initiate M-Pesa prompt.", error: data });
        }
    } catch (err) {
        console.error("Deposit Prompt Error:", err);
        res.status(500).json({ message: "Server error initiating deposit." });
    }
});

// 7. Modepay Webhook (Listens for successful payment from M-Pesa)

// ADDED: A GET route to handle gateway verification pings
app.get('/api/deposit/webhook', (req, res) => {
    res.status(200).json({ status: "success", message: "Webhook endpoint is active and awake." });
});

// UPDATED: Post route with immediate JSON success response
app.post('/api/deposit/webhook', async (req, res) => {
    try {
        // Immediately return 200 OK so Modepay marks the webhook as successfully delivered
        res.status(200).json({ status: "success", message: "Webhook received" });

        const { checkoutRequestId, status, amount } = req.body; 

        // Stop execution if it's just an empty test ping
        if (!checkoutRequestId) return; 

        const deposit = await Deposit.findOne({ checkoutRequestId });
        if (!deposit || deposit.status === "Completed") return;

        if (status === "SUCCESS") {
            deposit.status = "Completed";
            await deposit.save();

            const user = await User.findOne({ phone: deposit.userPhone });
            if (user) {
                user.balance += Number(amount);
                await user.save();
                
                // Emit socket event to update balance in real-time on frontend
                io.emit("balanceUpdated", { phone: user.phone, balance: user.balance });
            }
        } else {
            deposit.status = "Failed";
            await deposit.save();
        }
    } catch (err) {
        console.error("Webhook Error:", err);
    }
});

// 8. Get Deposit History
app.get('/api/deposits', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Unauthorized." });
        }
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const deposits = await Deposit.find({ userPhone: decoded.phone }).sort({ createdAt: -1 });
        
        // Format for frontend
        const formattedDeposits = deposits.map(d => ({
            _id: d._id,
            mpesaPhone: d.mpesaPhone,
            amount: d.amount,
            status: d.status,
            timestamp: new Date(d.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }));

        res.json({ success: true, deposits: formattedDeposits });
    } catch (err) {
        res.status(500).json({ message: "Error fetching deposits." });
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
        let forcedCrash = Math.min(20.00, targetMinMultiplier + (Math.random() * 5));
        return parseFloat(forcedCrash.toFixed(2));
    }

    if (Math.random() < 0.05) {
        return 1.00;
    }

    const r = Math.random();
    let crash = 1.01 + (r * r * 9.00); 

    if (crash > 20.00) {
        crash = 20.00;
    }

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
            if (oddsHistory.length > 10) {
                oddsHistory.shift(); 
            }

            io.emit("crash", { finalOdd: gameState.crashPoint });
            setTimeout(runGameLoop, 5000); 
        } else {
            gameState.currentOdd = parseFloat((gameState.currentOdd + 0.03).toFixed(2));
            io.emit("tick", { currentOdd: gameState.currentOdd });
        }
    }, 100);
}

runGameLoop();

// Automatic Chat Bot
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
    "Dor: nani ywangojea signals? 😂.",
    "Kasim: cashed out 3500 😜.",
    "John: watu watengeze doo.",
    "Fred: kusota tunasema bye bye 😂.",
    "Eddy: Don't just wait for signals.",
    "Sharon: huu mwaka ni wa kununua gari aisee 💯.",
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

    socket.on("requestWithdrawal", async (data) => {
        try {
            const { token, phone, amount } = data;
            
            if (!token) return;

            const decoded = jwt.verify(token, JWT_SECRET);
            const userPhone = decoded.phone;

            const withdrawal = new Withdrawal({
                userPhone: userPhone,
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
                timestamp: formattedTime
            });

        } catch (err) {
            console.error("Error saving withdrawal to MongoDB:", err);
        }
    });
});

// --- SERVER INITIALIZATION ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Aviator Game Server running on port ${PORT}`);
});
            
