const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

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

// 1. ADD HISTORY TRACKING
// We'll seed it with some initial values so the ribbon isn't empty on server start
let oddsHistory = [1.06, 2.19, 5.51, 1.45, 3.20]; 

function determineCrashPoint() {
    const now = new Date();
    const currentMinute = now.getMinutes();
    
    // High odd every 20 minutes
    if (currentMinute % 20 === 0) {
        return parseFloat((Math.random() * 15 + 10).toFixed(2));
    }
    
    // Random instant crash
    let randomNum = Math.random();
    if (randomNum < 0.05) return 1.00;
    
    return parseFloat((Math.random() * 3 + 1.05).toFixed(2));
}

function runGameLoop() {
    gameState.crashPoint = determineCrashPoint();
    gameState.currentOdd = 1.00;
    gameState.isFlying = true;

    io.emit("takeoff");
    console.log(`[Game Started] Target Crash Point: ${gameState.crashPoint}x`);

    const gameInterval = setInterval(() => {
        if (gameState.currentOdd >= gameState.crashPoint) {
            clearInterval(gameInterval);
            gameState.isFlying = false;
            
            // 2. UPDATE HISTORY ON CRASH
            oddsHistory.push(gameState.crashPoint);
            // Keep only the last 10 crash odds to avoid a massive array
            if (oddsHistory.length > 10) {
                oddsHistory.shift(); 
            }

            io.emit("crash", { finalOdd: gameState.crashPoint });
            console.log(`[Crashed] At ${gameState.crashPoint}x`);

            setTimeout(runGameLoop, 5000); // Wait 5 seconds before next round
        } else {
            gameState.currentOdd = parseFloat((gameState.currentOdd + 0.03).toFixed(2));
            io.emit("tick", { currentOdd: gameState.currentOdd });
        }
    }, 100);
}

runGameLoop();

// 3. CREATE THE AUTOMATIC CHAT BOT
const botMessages = [
    "Alex: Just cashed out 500 KES! 💸",
    "Sarah: Waiting for 10x 🚀",
    "Kevo: Wow, crashed so fast 😭",
    "Mike: Let's goooo!",
    "Joy: Who is betting high this round?",
    "Mwangi: Nice win right there." ,
    "mwendee: what a day 🎉." ,
    "walalka: waiting for the signals." ,
    "katana: just received the withdrawal😜." ,
];

// Send a random bot message every 3 seconds
setInterval(() => {
    const randomMsg = botMessages[Math.floor(Math.random() * botMessages.length)];
    io.emit("chat message", randomMsg);
}, 3000); 


io.on("connection", (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    // 4. SEND FULL STATE + HISTORY TO NEW PLAYERS
    // Now, anyone who connects/refreshes instantly gets the TRUE server history
    socket.emit("sync", {
        currentOdd: gameState.currentOdd,
        isFlying: gameState.isFlying,
        history: oddsHistory
    });

    socket.on("chat message", (data) => {
        console.log(`Chat message: ${data}`);
        io.emit("chat message", data);
    });

    socket.on("disconnect", () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aviator Game Server running on port ${PORT}`);
});
    
