const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static frontend assets from the public directory
app.use(express.static(path.join(__dirname, 'public')));
// Root pe index.html bhej do
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Store active lobby rooms and player data
const rooms = {};

// Game arena configuration settings
const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const MAX_FOOD = 200;

// Utility function to generate random arena food
function generateFoodItem() {
    const foodTypes = [
        { name: 'Apple', color: '#ff3333', symbol: '🍎', radius: 10 },
        { name: 'Carrot', color: '#ff9900', symbol: '🥕', radius: 10 },
        { name: 'Strawberry', color: '#ff0066', symbol: '🍓', radius: 10 },
        { name: 'Orange', color: '#ffa500', symbol: '🍊', radius: 10 },
        { name: 'Corn', color: '#ffff33', symbol: '🌽', radius: 10 },
        { name: 'Banana', color: '#ffe135', symbol: '🍌', radius: 10 }
    ];
    const type = foodTypes[Math.floor(Math.random() * foodTypes.length)];
    return {
        id: Math.random().toString(36).substring(2, 9),
        x: Math.floor(Math.random() * (MAP_WIDTH - 100)) + 50,
        y: Math.floor(Math.random() * (MAP_HEIGHT - 100)) + 50,
        ...type
    };
}

// Populate initial food for room creation
function createRoomFoodList() {
    const foodArray = [];
    for (let i = 0; i < MAX_FOOD; i++) {
        foodArray.push(generateFoodItem());
    }
    return foodArray;
}

io.on('connection', (socket) => {
    console.log(`[+] New Player Connected: ${socket.id}`);

    // Fetch and send live lobby server rooms
    socket.on('getRooms', () => {
        const roomList = Object.keys(rooms).map(roomName => ({
            name: roomName,
            map: rooms[roomName].mapName,
            players: `${Object.keys(rooms[roomName].players).length} / ${rooms[roomName].maxPlayers}`,
            ping: `${Math.floor(Math.random() * 20 + 15)}ms`
        }));
        socket.emit('roomList', roomList);
    });

    // Create a new room
    socket.on('createRoom', ({ roomName, mapName, maxPlayers }) => {
        const name = roomName || `Room_${Math.floor(1000 + Math.random() * 9000)}`;
        if (!rooms[name]) {
            rooms[name] = {
                name: name,
                mapName: mapName || "Dust Arena",
                maxPlayers: maxPlayers || 10,
                players: {},
                foods: createRoomFoodList()
            };
        }
        socket.emit('roomCreated', name);
    });

    // Join room event
    socket.on('joinRoom', ({ roomName, nickname, skin, trail }) => {
        let room = rooms[roomName];

        // Create fallback default room if joining unknown room
        if (!room) {
            roomName = "Dust_Arena_1";
            if (!rooms[roomName]) {
                rooms[roomName] = {
                    name: roomName,
                    mapName: "Dust Arena",
                    maxPlayers: 10,
                    players: {},
                    foods: createRoomFoodList()
                };
            }
            room = rooms[roomName];
        }

        socket.join(roomName);
        socket.currentRoom = roomName;

        // Initialize player physics data
        room.players[socket.id] = {
            id: socket.id,
            name: nickname || "Player",
            x: Math.floor(Math.random() * (MAP_WIDTH - 200)) + 100,
            y: Math.floor(Math.random() * (MAP_HEIGHT - 200)) + 100,
            score: 0,
            kills: 0,
            skin: skin,
            trail: trail,
            nodes: []
        };

        // Notify client of successful initialization
        socket.emit('initGameState', {
            playerId: socket.id,
            players: room.players,
            foods: room.foods,
            mapWidth: MAP_WIDTH,
            mapHeight: MAP_HEIGHT
        });

        // Broadcast new player join to others
        socket.to(roomName).emit('playerJoined', room.players[socket.id]);
    });

    // Position updates from clients
    socket.on('updatePlayerPosition', (playerData) => {
        const roomName = socket.currentRoom;
        if (roomName && rooms[roomName] && rooms[roomName].players[socket.id]) {
            rooms[roomName].players[socket.id].x = playerData.x;
            rooms[roomName].players[socket.id].y = playerData.y;
            rooms[roomName].players[socket.id].nodes = playerData.nodes;
            rooms[roomName].players[socket.id].score = playerData.score;

            // Broadcast movement update to other players in room
            socket.to(roomName).emit('playerMoved', {
                id: socket.id,
                x: playerData.x,
                y: playerData.y,
                nodes: playerData.nodes,
                score: playerData.score
            });
        }
    });

    // Player food collection handling
    socket.on('eatFood', (foodId) => {
        const roomName = socket.currentRoom;
        if (roomName && rooms[roomName]) {
            const foodIndex = rooms[roomName].foods.findIndex(f => f.id === foodId);
            if (foodIndex !== -1) {
                // Remove food item and create a new replacement
                rooms[roomName].foods.splice(foodIndex, 1);
                const newFood = generateFoodItem();
                rooms[roomName].foods.push(newFood);

                // Sync new state with room
                io.in(roomName).emit('foodUpdated', {
                    eatenFoodId: foodId,
                    newFood: newFood
                });
            }
        }
    });

    // Handle Player Elimination Event
    socket.on('playerKilled', ({ killerId, victimId }) => {
        const roomName = socket.currentRoom;
        if (roomName && rooms[roomName]) {
            if (rooms[roomName].players[killerId]) {
                rooms[roomName].players[killerId].kills += 1;
                rooms[roomName].players[killerId].score += 100;
            }

            io.in(roomName).emit('playerEliminated', {
                killerId: killerId,
                victimId: victimId,
                victimName: rooms[roomName].players[victimId]?.name || "Snake"
            });
        }
    });

    // Disconnect event
    socket.on('disconnect', () => {
        console.log(`[-] Player Disconnected: ${socket.id}`);
        const roomName = socket.currentRoom;

        if (roomName && rooms[roomName]) {
            delete rooms[roomName].players[socket.id];
            socket.to(roomName).emit('playerLeft', socket.id);

            // Cleanup empty custom room
            if (Object.keys(rooms[roomName].players).length === 0 && roomName !== "Dust_Arena_1") {
                delete rooms[roomName];
            }
        }
    });
});

// Start web server listening port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`ZENOX SNAKE SERVER RUNNING`);
    console.log(`Listening on http://localhost:${PORT}`);
    console.log(`=================================`);
});

