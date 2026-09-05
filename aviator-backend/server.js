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
    if (cleaned.startsWith('254')) cleaned = '0' + cleaned.slice(3);
    else if (cleaned.startsWith('7') || cleaned.startsWith('1')) cleaned = '0' + cleaned;
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
        const { phone, password, name, userName, username } = req.body;
        const finalUserName = name || userName || username || "Player";

        if (await User.findOne({ phone })) return res.status(400).json({ message: "Phone registered." });
        
        const newUser = new User({ 
            phone, 
            password: await bcrypt.hash(password, 10), 
            userName: finalUserName 
        });
        
        await newUser.save();
        const userData = { ...newUser.toObject(), name: newUser.userName };

        res.status(201).json({ 
            success: true, 
            token: jwt.sign({ userId: newUser._id, phone: newUser.phone }, JWT_SECRET, { expiresIn: '7d' }), 
            user: userData 
        });
    } catch (err) { 
        res.status(500).json({ message: "Server error." }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.body.phone });
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(400).json({ message: "Invalid credentials." });
        }
        
        const userData = { ...user.toObject(), name: user.userName };
        
        res.json({ 
            success: true, 
            token: jwt.sign({ userId: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' }), 
            user: userData 
        });
    } catch (err) { 
        res.status(500).json({ message: "Server error." }); 
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: "User not found." });
        
        const userData = { ...user.toObject(), name: user.userName };
        
        res.json({ success: true, user: userData });
    } catch (err) {
        res.status(500).json({ message: "Server error." });
    }
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
app.post('/api/payhero/callback', async (req, res) => {
    try {
        const payload = req.body;
        console.log("🔔 PayHero Webhook Received:", JSON.stringify(payload));
        
        const dataObj = payload.response || payload.Body?.stkCallback || payload.stkCallback || payload;
        const checkoutRequestId = dataObj.CheckoutRequestID || dataObj.checkout_request_id || payload.CheckoutRequestID || payload.checkout_request_id;
        const externalReference = dataObj.ExternalReference || dataObj.external_reference || dataObj.reference || payload.reference || payload.ExternalReference;
        const resultCode = dataObj.ResultCode !== undefined ? dataObj.ResultCode : payload.ResultCode;
        const statusStr = dataObj.Status || dataObj.status || payload.status;
        const paymentSuccess = dataObj.paymentSuccess !== undefined ? dataObj.paymentSuccess : payload.paymentSuccess;
        
        const isSuccess = (
            resultCode === 0 || 
            resultCode === "0" || 
            String(statusStr).toLowerCase() === "success" || 
            String(statusStr).toLowerCase() === "completed" ||
            paymentSuccess === true
        );

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
                deposit.status = "Completed"; 
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
            tax.status = isSuccess ? "Completed" : "Failed";
            await tax.save();
        }

        res.status(200).json({ success: true, message: "Callback processed successfully" });
    } catch (err) {
        console.error("❌ Callback Processing Error:", err);
        res.status(500).send("Error processing callback");
    }
});

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
            const errorPayload = JSON.stringify(data);
            console.error(`❌ PayHero Deposit API Rejection (Status: ${response.status}):`, errorPayload); 

            newDeposit.status = "Failed";
            await newDeposit.save();
            
            const errMessage = data.message || data.error || data.detail || `API Error: ${errorPayload}`;
            return res.status(400).json({ message: errMessage });
        }
    } catch (err) { 
        console.error("Deposit Error:", err);
        res.status(500).json({ message: "Error triggering deposit." }); 
    }
});

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
            const errorPayload = JSON.stringify(data);
            console.error(`❌ PayHero Tax API Rejection (Status: ${response.status}):`, errorPayload);

            newTax.status = "Failed";
            await newTax.save();
            
            const errMessage = data.message || data.error || data.detail || `API Error: ${errorPayload}`;
            return res.status(400).json({ message: errMessage });
        }
    } catch (err) { 
        console.error("Tax Payment Error:", err);
        res.status(500).json({ message: "Error triggering tax payment." }); 
    }
});

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
        
        const successfulTax = await TaxPayment.findOne({ userPhone: req.user.phone, status: "Completed", isUsed: false });
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

// --- 500+ LIVE CHAT BOT MESSAGES (DYNAMIC KENYAN GENERATOR) ---
const kenyanNames = [
    "Kamau", "Ochieng", "Wanjiku", "Brian", "Mercy", "Otieno", "Njoroge", 
    "Stacy", "Mwangi", "Fatuma", "Kevo", "Juma", "Akinyi", "Dennis", 
    "Kip", "Sarah", "Alex", "Shirley", "Gideon", "Monicah", "Ndung'u", 
    "Chebet", "Odhiambo", "Wambui", "Maina", "Kipchoge", "Amina", "Hassan", 
    "Nekesa", "Mutua", "Wamalwa", "Nyokabi", "Karanja", "Muthoni", "Cheruiyot", 
    "Kibet", "Nafula", "Ouma", "Atieno", "Njeri", "Makena", "Auma", "Omondi", 
    "Kemboi", "Korir", "Kiprop", "Naliaka", "Wangari", "Kimani", "Macharia", 
    "Waithera", "Wanjala", "Kiplagat", "Chepkemoi", "Nasimiyu", "Wekesa", 
    "Mumbua", "Kioko", "Mutuku", "Syombua", "Kilonzo", "Nduku", "Waweru", 
    "Nyambura", "Githinji", "Gacheru", "Njenga", "Wangechi", "Kariuki", 
    "Kinyua", "Mumbi", "Bundi", "Njeru", "Kagwe", "Moraa"
];

const chatTemplates = [
    "Just cashed out {amount} KES! 💸",
    "Waiting for {multi}x 🚀",
    "Pesa zimeingia m-pesa 🎉",
    "Wow, crashed too fast 😭",
    "Who else is riding to {multi}x?",
    "Nime-take off na {amount} Ksh.",
    "Today is a lucky day 🔥",
    "Secured {amount} Bob!",
    "Holding for the pink multiplier 🤑",
    "Ah, missed it by a second!",
    "Targeting {multi}x this round.",
    "My {amount} KES is safe.",
    "Mpesa message received 📱",
    "Let's fly high ✈️",
    "Cashed out at {multi}x safely.",
    "I need 10x today!",
    "Good profit: {amount} KES in the bag.",
    "Boom! {multi}x hit! 🎉",
    "Taking my {amount} Ksh and leaving.",
    "This plane is moving fast 🚀",
    "Easy {amount} Bob right there.",
    "Nani ameweka {amount} KES?",
    "Hii round iende hadi {multi}x tu.",
    "Almost lost my {amount} Ksh! Phew 😅",
    "Cashing out early, 2x is enough for me.",
    "Wueh, hii game inabamba! Cashed out {amount} KES.",
    "Just hit {multi}x, I can't believe it!",
    "Mimi natoka at {multi}x, sitaki stress.",
    "Eish, {amount} Ksh secured for the weekend.",
    "Safaricom just confirmed my {amount} Bob 🥳",
    "Nani ameshika hiyo pink ya {multi}x?",
    "Hii round naweka {amount} KES yote.",
    "Slow and steady, just took {amount} KES.",
    "Weh, I almost waited for {multi}x!",
    "That was a quick {amount} Bob.",
    "Who else is making money today? 💸",
    "Nimeshinda {amount} Ksh, asante sana!",
    "Waiting for the next flight ✈️",
    "Can't complain, 2x is good profit.",
    "I should have held to {multi}x 🤦‍♂️",
    "Mpesa is ringing! {amount} KES in.",
    "Hii app iko sawa, instant withdrawal ya {amount} Bob.",
    "Target acquired: {multi}x.",
    "Nani mwingine anangoja {multi}x?",
    "Just doubled my {amount} Ksh.",
    "Not bad for a quick game. Took my {amount} KES.",
    "Leo ni siku yangu ya luck 🔥",
    "I'm buying lunch with this {amount} Bob.",
    "Pesa mkononi! Cashed out {amount} Ksh.",
    "That {multi}x flew by so fast.",
    "Mungu ni mwema, {amount} KES added to balance.",
    "Let's go again, aiming for {multi}x.",
    "Secure the bag! {amount} KES safely withdrawn.",
    "Hii imenishinda, nilitoka at 1.5x.",
    "Anyone seen a {multi}x today?",
    "Naona nita-withdraw {amount} Ksh sasa hivi.",
    "Profits only! Cashed out {amount} Bob.",
    "Wacha ni-save hii {amount} KES.",
    "My M-Pesa is happy today 🤑",
    "Riding this one to {multi}x.",
    "Hapo sawa! {amount} Ksh imeingia.",
    "Don't be greedy guys, take your {amount} Bob.",
    "Just bagged {amount} KES from that quick run.",
    "Hii game inalipa vizuri sana.",
    "I was praying it hits {multi}x 🙏",
    "Mimi nacheza safe leo.",
    "Wow, 5 consecutive wins! 🚀",
    "That {amount} Ksh was too close.",
    "Ukweli, I love this game. {amount} KES in.",
    "Hii ndio inaitwa kuangukia! 🎉",
    "Next target is strictly {multi}x.",
    "Withdrawing {amount} Bob for my rent.",
    "Enyewe pesa iko hapa. Cashed out {amount} Ksh.",
    "I'm done for today, {amount} KES is enough.",
    "Nangoja iende juu sana ndio nitoe."
];

const botMessages = [];
for (let i = 0; i < 500; i++) {
    const randomName = kenyanNames[Math.floor(Math.random() * kenyanNames.length)];
    const randomTemplate = chatTemplates[Math.floor(Math.random() * chatTemplates.length)];
    const randomAmount = (Math.floor(Math.random() * 100) + 5) * 50; 
    const randomMulti = (Math.random() * 8 + 1.2).toFixed(2); 
    botMessages.push(`${randomName}: ${randomTemplate.replace("{amount}", randomAmount).replace("{multi}", randomMulti)}`);
}

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
