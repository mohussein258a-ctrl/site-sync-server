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

function determineCrashPoint() {
    const now = new Date();
    const currentMinute = now.getMinutes();
    
    if (currentMinute % 20 === 0) {
        return parseFloat((Math.random() * 15 + 10).toFixed(2));
    }
    
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
            
            io.emit("crash", { finalOdd: gameState.crashPoint });
            console.log(`[Crashed] At ${gameState.crashPoint}x`);

            setTimeout(runGameLoop, 5000);
        } else {
            gameState.currentOdd = parseFloat((gameState.currentOdd + 0.03).toFixed(2));
            io.emit("tick", { currentOdd: gameState.currentOdd });
        }
    }, 100);
}

runGameLoop();

io.on("connection", (socket) => {
    console.log(`Player connected: ${socket.id}`);
    socket.emit("sync", gameState);

    socket.on("disconnect", () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aviator Game Server running on port ${PORT}`);
});
