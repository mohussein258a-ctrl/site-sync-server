const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function getCurrentIntervalState() {
    const now = new Date();
    const minutes = now.getMinutes();
    const minuteInHour = minutes % 20;
    
    let activeInterval = 1;
    if (minutes >= 20 && minutes < 40) activeInterval = 2;
    if (minutes >= 40) activeInterval = 3;

    return {
        activeInterval,
        serverTime: now.getTime(),
        progressInBlock: minuteInHour
    };
}
app.get('/', (req, res) => {
  res.send('Site Sync Server is live and running!');
});

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'SYNC', data: getCurrentIntervalState() }));
});

setInterval(() => {
    const currentState = getCurrentIntervalState();
    const stateData = JSON.stringify({ type: 'SYNC_STATE', ...currentState });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(stateData);
        }
    });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sync server running on port ${PORT}`);
});
