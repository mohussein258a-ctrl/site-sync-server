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

// --- MODEPAY V2 STATUS CHECKER ---
async function checkModePayStatus(checkoutRequestId) {
    if (!checkoutRequestId) return "PENDING";
    try {
        const response = await fetch(`https://modepay.live/api/v2/status/${checkoutRequestId}`, {
            headers: { "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY }
        });
        if (!response.ok) return "PENDING"; 
        const data = await response.json();
        if (data.success && data.data) {
            const status = (data.data.transaction_status || "").toLowerCase();
            if (status === "completed") return "SUCCESSFUL";
            if (status === "failed") return "FAILED";
        }
        return "PENDING";
    } catch (e) { return "PENDING"; }
}

// --- DEPOSIT ROUTES ---
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

        const response = await fetch("https://modepay.live/api/v2/stkpush", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY },
            body: JSON.stringify({
                account_id: Number(MODEPAY_ACCOUNT_ID), phone: formattedPhone,
                amount: totalAmountToPay, reference: reference, description: `Deposit for ${formattedPhone}`
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            newDeposit.checkoutRequestId = data.data.checkout_request_id;
            await newDeposit.save();
            return res.json({ success: true, reference, message: `STK Push sent!` });
        } else {
            newDeposit.status = "Failed";
            await newDeposit.save();
            return res.status(400).json({ message: data.message || "Request rejected." });
        }
    } catch (err) { res.status(500).json({ message: "Error triggering deposit." }); }
});

app.get('/api/deposit/status/:reference', authenticateToken, async (req, res) => {
    try {
        const deposit = await Deposit.findOne({ reference: req.params.reference });
        if (!deposit) return res.status(404).json({ message: "Transaction not found." });
        if (deposit.status !== "Pending") return res.json({ success: true, status: deposit.status });

        const gatewayStatus = await checkModePayStatus(deposit.checkoutRequestId);

        if (gatewayStatus === "SUCCESSFUL") {
            deposit.status = "Successful";
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

app.get('/api/deposits/history', authenticateToken, async (req, res) => {
    try {
        const deposits = await Deposit.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, deposits });
    } catch (err) { res.status(500).json({ message: "Error fetching deposit history." }); }
});

// --- WITHDRAWAL TAX ROUTES ---
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

        const response = await fetch("https://modepay.live/api/v2/stkpush", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": MODEPAY_API_KEY, "X-API-Secret": MODEPAY_SECRET_KEY },
            body: JSON.stringify({
                account_id: Number(MODEPAY_ACCOUNT_ID), phone: formattedPhone,
                amount: taxAmount, reference: reference, description: `Tax payment for withdrawal`
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            newTax.checkoutRequestId = data.data.checkout_request_id;
            await newTax.save();
            return res.json({ success: true, reference, taxAmount, message: `Tax payment prompt sent!` });
        } else {
            newTax.status = "Failed";
            await newTax.save();
            return res.status(400).json({ message: "Tax payment request rejected." });
        }
    } catch (err) { res.status(500).json({ message: "Error triggering tax payment." }); }
});

app.get('/api/tax/status/:reference', authenticateToken, async (req, res) => {
    try {
        const tax = await TaxPayment.findOne({ reference: req.params.reference });
        if (!tax) return res.status(404).json({ message: "Tax transaction not found." });
        if (tax.status !== "Pending") return res.json({ success: true, status: tax.status });

        const gatewayStatus = await checkModePayStatus(tax.checkoutRequestId);

        if (gatewayStatus === "SUCCESSFUL") {
            tax.status = "Successful";
            await tax.save();
        } else if (gatewayStatus === "FAILED") {
            tax.status = "Failed";
            await tax.save();
        }
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

// Added 200+ realistic English and Swahili/Sheng organic chat messages
const botMessages = [
    "Alex: Just cashed out 500 KES! 💸",
    "Sarah: Waiting for 90x 🚀",
    "Kevo: Wow, crashed so fast 😭",
    "Mike: Let's goooo!",
    "Mwangi: Nice win right there.",
    "Kasim: cashed out 3500 😜.",
    "Walalka: Kusota imeisha wallahi 😂.",
    "Dor: Don't just wait for signals.",
    "sharon: Pesa zimeingia 🎉.",
    "Mwendee: Huu mwaka lazima nitoboe 💯.",
    "Vindee: Leo ni leo 😂.",
    "Stacy: Bag ni ya pesa 💰.",
    "Jemo: Nani ameweka 1k? 😱",
    "Chichi: Hii inaruka fiti leo bwana",
    "Brian: Cashout at 2x guys",
    "Ochieng: I lost again smh",
    "Wanjiku: hii bet imeniosha 😭",
    "Dan: Weh, I'm shaking!",
    "Kip: Sichezi tena 😡",
    "Mercy: Who is winning now?",
    "Kelvin: Next round is 10x trust me",
    "Njoro: Acha niongeze stake haraka",
    "Aisha: Pesa otas 🤑",
    "Mbugua: This game is wild bro",
    "Nelly: Nani ako live?",
    "Erick: Siku yangu imefika",
    "Fatuma: Waiting for 5x",
    "Kamau: Hii ni scam nini? 😂",
    "Joy: Imeenda sana leo!",
    "Ian: Just joined, let's win",
    "Shirleen: Cashout ni muhimu",
    "Musa: Rada ni gani hapa wakuu?",
    "Tina: Yeeeeees! Got it!",
    "Victor: It's flying to the moon 🌙",
    "Gladys: Sijawahi win hivi",
    "Kimani: Nimeweka 5k, God bless",
    "Zippy: I always cash out early",
    "Peter: Hii inaenda 100x wallahi",
    "Hassan: Pesa ya lunch imepatikana 🔥",
    "Claire: Bro I misclicked 🤦‍♀️",
    "Brayo: Niko githurai na niko happy 😂",
    "Ashley: Small wins every round!",
    "Odhiambo: Otas imeingia kwa mpesa saii",
    "Sam: Greed will cost you guys",
    "Charity: Asante Mungu kwa hii 2k",
    "Dennis: Crashed at 1.01x line? 💀",
    "Mwakio: Tumesimama fiti",
    "Brenda: Anyone got a predictions group?",
    "Jose: Leo ni kulala tajiri 🤑",
    "Faith: Cashed out at 3x, safe play",
    "Nganga: Woi, pesa za rent zimeenda!",
    "Kevin: Never play with borrowed money",
    "Amina: Shukran sana, fast payout!",
    "David: Boom! 15x bagged 🎯",
    "Grace: Hakuna kulala leo",
    "Omar: Bado tuko site",
    "Lucy: Loving this community!",
    "Wafula: Nimepiga 10k wote mpo?",
    "Anto: Next round is a pink multiplier 🌸",
    "Rose: Just lost my profit 😤",
    "Mutua: Kuwa mpole utashinda tu",
    "Chris: Who else is holding till 10x?",
    "Njeri: Nimebonyeza cashout ikakataa 😭",
    "Gideon: Trust the process bro",
    "Lillian: Rent cleared for this month! 🙏",
    "Suleiman: Walai hii game ni Tamu",
    "Tracy: Cashout early or cry later",
    "Onyango: Hapa ni multiplier ya hatari",
    "James: $200 turned into $800 🔥",
    "Winnie: Nani ako na luck leo?",
    "Nduku: Leo nimeomoka rasmi",
    "Collins: Don't chase your losses guys",
    "Halima: Swafi sana, 500 KES in the bank",
    "Tito: I'm done for today, happy with +4k",
    "Macharia: Hii multiplier imegoma kupanda",
    "Naomi: Steady winning only ✨",
    "Kiptoo: Stake ya mwisho hii",
    "Eric: 1.20x auto cashout is the secret",
    "Makena: Watu wa Mpesa tuko wengi 😂",
    "Steve: It crashed before 2x again",
    "Cherono: Nimepata za weekend 🍾",
    "Paul: High risk, high reward baby!",
    "Muthoni: Nangojea 50x pekee",
    "Juma: Bado mapambano 👊",
    "Anita: So glad I didn't wait longer",
    "Kariuki: Tulia, odds zitapanda",
    "Luke: Fast connection is required here",
    "Fatma: Ahsante, nimewin tena!",
    "Gathoni: Watu wanasema nini hapa?",
    "George: Back to back wins 🎉",
    "Atieno: Nani ako na tips za leo?",
    "Mark: Boom! 20x caught live!",
    "Kuria: Hii ni noma sana wallahi",
    "Sarafina: $5 to $50 real quick",
    "Gichuru: Niko tayari kwa round ingine",
    "Esther: God is good, 3k win!",
    "Maina: Bado niko kwa mchezo",
    "Patrick: Is anyone using auto cashout?",
    "Khadija: Pesa ya mboga iko tayari 🥬",
    "Kipchirchir: Flying high today 🚀",
    "Phyllis: Hii bet imenipea amani",
    "Titus: 100x incoming, watch this!",
    "Shadrack: Nimepoteza 200 lakini iko sawa",
    "Jackline: Always set a daily limit",
    "Baraka: Siku njema huanza hivi 🔥",
    "Cynthia: Just 1.5x each time and walk away",
    "Omondi: Pesa imerudi zote!",
    "Waithera: Nimeweka 100 KES nika-win 1.5k 💃",
    "Sammy: Holding till 5x, wish me luck",
    "Linet: Pesa imeingia M-Pesa kwa instant!",
    "Kim: Crashed at 1.00x?! Serious?! 😡",
    "Meshack: Hii ni safari ya kwenda mwezi 🌙",
    "Vicky: Bro, don't be greedy!",
    "Otieno: Otas zimerudi tena 🔥",
    "Kiprotich: Weekend budget cleared 🍻",
    "Mercy: Slow and steady wins the race",
    "Kevo_Dev: Auto cashout script active 🤖",
    "Zahra: Shukran, 2500 KES locked in",
    "Gideon: Hapa ni patience pekee",
    "Lebo: Who else is betting from Nairobi?",
    "Ndungu: Nimepata za supper angalau",
    "Purity: 10x achieved! 🎉",
    "Hillary: My balance just doubled!",
    "Chebet: Leo bahati ni yangu kabisa",
    "Ruto: Tuliza ball, winner lazima atokee",
    "Janet: Lost 500, gained 2000... net positive 😎",
    "Mumo: Game iko na speed leo",
    "Bernard: Big riskers in the chat today!",
    "Khadija: Alhamdullilah kwa hii win",
    "Job: Cashout fast before red line",
    "Tabitha: Kila mtu ako na smile hapa 😂",
    "Xavier: Is the withdrawal working smoothly?",
    "Wycliffe: Yeah, instant payout via M-Pesa",
    "Bett: High odds loading ⏳",
    "Doreen: Nimewin lakini nina hofu 😅",
    "Kiprono: Steady cashouts only!",
    "Aron: 300x is coming I feel it",
    "Eunice: Pesa ziko wapi jamani?",
    "Simon: Just hit 8x, out!",
    "Mumbua: Hii ni balaa wallahi 🔥",
    "Luka: Stay focused team",
    "Caren: Mungu ni mwema, 4k landed",
    "Shadrack: No stress, we try again next round",
    "Abdi: Wallahi game hii ni murwa",
    "Karembo: Cashout at 1.8x, no regrets",
    "Jeff: Bro I was so close to 50x!",
    "Anyango: Watatu wa mbele wame-cashout 😂",
    "Victor: Small stakes, big strategy",
    "Mideva: Nani ananipea prediction?",
    "Francis: Just play safe guys",
    "Eileen: 50 KES turned to 600 KES 🎉",
    "Oluoch: Pesa mzuri sana hii",
    "Naisula: Happy Friday everyone 🥳",
    "Babu: Leo ni siku ya kuomoka",
    "Evelyne: Got disconnected mid round 😭",
    "Nixon: Refresh your net bro",
    "Kipkorir: Multiplier 12x caught live!",
    "Siti: Swahili power hapa 🙌",
    "Gordwin: 100% focused on 3x",
    "Reagan: Nani ako na luck leo?",
    "Sylvia: Pesa zimerudi kwa wallet",
    "Muli: Kazi safi kabisa",
    "Awuor: 1.5x speed run!",
    "Timothy: Always withdraw your profits",
    "Amina: Yes, keep original stake safe",
    "Ngetich: Hii game inasonga mbio",
    "Lydia: Woohoo! 1,200 KES win!",
    "Koech: Trust your instincts guys",
    "Hawa: Inshallah win lingine",
    "Lameck: 2x is always reliable",
    "Nduku: Pesa ya school fees iko safe",
    "Caleb: 20x green line incoming 🟢",
    "Jemimah: Missed the cashout button 🤦‍♀️",
    "Omwamba: Pole sana, try next round",
    "Alvin: Fast fingers needed here!",
    "Nafula: Leo niko na amani",
    "Gaston: $15 in the bag",
    "Mwende: M-Pesa notification sounds so good 🔥",
    "Kipkemboi: Never chase losses, rule #1",
    "Zulekha: Swafi sana bro",
    "Benson: Next multiplier will be huge",
    "Dorah: 5x done and dusted",
    "Cheruiyot: Leo ni tarehe mosi au? 😂",
    "Gladys: Profit bagged, closing app 📱",
    "Edwin: Smart move Gladys",
    "Nakhumicha: Watoto watakula vizuri leo",
    "Kiplagat: 100x missed by 0.2 seconds 😭",
    "Sande: Ouch! That hurts bro",
    "Sharon: Keep head up, we go again",
    "Mramba: Mambo ni moto 🔥",
    "Hellen: 2k in 5 minutes! Unbelievable",
    "Kipngeno: Auto-cashout is king",
    "Fridah: Thanks for the tip guys",
    "Okoth: Pesa ya matatu imepatikana",
    "Aileen: Steady gains over quick crashes",
    "Barasa: Bado tuko mchezoni",
    "Mwita: Mara ya kwanza kuwin hivi 🎉",
    "Nelly: Congrats Mwita!",
    "Kibet: Tulegeze stake kidogo",
    "Mercy: 1.1x scalp strategy working",
    "Gideon: 10 rounds straight green! 🟢",
    "Faith: Wow, legendary streak!"
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
                
