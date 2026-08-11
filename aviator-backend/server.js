const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());

// --- MONGODB CONNECTION ---
// SECURITY FIX: Strictly using the environment variable. 
// Set MONGODB_URI in your Render dashboard environment variables.
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI is not defined in environment variables.");
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- USER DATABASE SCHEMA ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userName: { type: String, required: true },
    balance: { type: Number, default: 1000 }
});

const User = mongoose.model('User', userSchema);

// --- AUTHENTICATION & BALANCE API ROUTES ---

// 1. Account Registration
app.post('/api/register', async (req, res) => {
    try {
        // NOTE: Your frontend HTML MUST send a JSON object with { phone, password, name }
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

        res.status(201).json({ 
            success: true, 
            user: { phone: newUser.phone, name: newUser.userName, balance: newUser.balance } 
        });
    } catch (err) {
        console.error("Registration Error:", err);
        // Returns the actual error message to the frontend for easier debugging
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

        res.json({ 
            success: true, 
            user: { phone: user.phone, name: user.userName, balance: user.balance } 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: "Server error during login." });
    }
});

// 3. Update Balance
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
        let forcedCrash = targetMinMultiplier + (Math.random() * 15);
        return parseFloat(forcedCrash.toFixed(2));
    }

    if (Math.random() < 0.05) return 1.00; 
    
    let e = 0.01; 
    let r = Math.random();
    let crash = Math.max(1.00, (100 / (r * 100 + e)).toFixed(2));
    
    if (crash > 15.00) crash = (Math.random() * 5 + 1.05).toFixed(2);

    return parseFloat(crash);
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
    "Seif: aisee, leo ni leo🔥." ,
    "Dor: nani ywangojea signals? 😂." ,
    "Kasim: cashed out 3500 😜.",
];

setInterval(() => {
    const randomMsg = botMessages[Math.floor(Math.random() * botMessages.length)];
    io.emit("chat message", randomMsg);
}, 3000); 

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

    socket.on("requestWithdrawal", (data) => {
        const { phone, amount } = data;
        socket.emit("withdrawalStatus", {
            phone: phone,
            amount: amount,
            status: "Pending",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aviator Game Server running on port ${PORT}`);
});
